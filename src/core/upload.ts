/**
 * External dependencies
 */
import { randomBytes } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/**
 * Internal dependencies
 */
import type { EndpointArgSchema } from '../types.js';
import { debugLog, redactBody, redactHeaders } from './debug.js';
import { sanitizeFilename } from './download.js';
import { CliError, parseErrorResponse } from './errors.js';
import { extensionOf, mimeForFilename } from './mime.js';

/** Default idle/response timeout for an upload, in milliseconds. */
export const DEFAULT_UPLOAD_TIMEOUT_MS = 300_000;

/** Socket errors that mean "the server hung up on us mid-upload". */
const HANG_UP_CODES = new Set( [
	'EPIPE',
	'ECONNRESET',
	'ECONNABORTED',
	'UND_ERR_SOCKET',
] );

/** A local file, ready to be streamed as one multipart file part. */
export interface PreparedFile {
	field: string;
	path: string;
	filename: string;
	size: number;
	mimeType: string;
}

/** The result of an upload request, shaped like a client response. */
export interface UploadResponse {
	status: number;
	headers: Headers;
	body: unknown;
}

/** What a `create`/`update` command's fields turned out to contain. */
export interface UploadPlan {
	/** Fields that stay ordinary form fields. */
	textFields: Record< string, string >;
	/** Each file field with the sources (paths or URLs) given for it. */
	files: Array< { field: string; sources: string[] } >;
	/** Fields whose value was recognised as a file only by looking at it. */
	detected: string[];
}

/** Inputs to {@link planUploads}. */
export interface PlanUploadsOptions {
	namespace: string;
	route: string;
	fields: Record< string, string >;
	repeated?: Record< string, string[] >;
	args?: Record< string, EndpointArgSchema >;
}

/**
 * Whether a route is one of core's own upload routes, whose file field (`file`)
 * WordPress declares nowhere in its schema — the only place a route name is used.
 * @param namespace The route namespace.
 * @param route     The `/`-joined route.
 * @return True for `wp/v2` `media` and `media/sideload`.
 */
function isKnownUploadRoute( namespace: string, route: string ): boolean {
	return (
		namespace === 'wp/v2' &&
		( route === 'media' || route === 'media/sideload' )
	);
}

/** Fields that hold prose or identifiers, never files, on any WordPress route. */
const TEXT_FIELDS = new Set( [
	'title',
	'content',
	'excerpt',
	'slug',
	'name',
	'description',
	'caption',
	'alt_text',
	'status',
	'password',
	'author_name',
	'search',
] );

/**
 * Guesses whether a bare field value is a file to upload: an `http(s)://` URL, or
 * a path that looks like one and points at an existing regular file. Fields whose
 * schema says they aren't plain strings, or are URIs (`link`, `source_url`), fields
 * named like prose (`title`, `content`, ...), and routes with no schema are never guessed.
 * @param name   The field name.
 * @param value  The raw field value.
 * @param schema The field's live arg schema, if the route declares it.
 * @return True when the value should be uploaded as a file.
 */
function looksLikeFile(
	name: string,
	value: string,
	schema: EndpointArgSchema | undefined
): boolean {
	// Never guess without the route's schema, for well-known text fields, or for
	// anything not declared as a plain string (core's `content`/`title` are
	// `["object", "string"]`).
	if ( ! schema || TEXT_FIELDS.has( name ) || schema.type !== 'string' ) {
		return false;
	}
	if ( /^https?:\/\//i.test( value ) ) {
		return ! [ 'uri', 'url', 'iri' ].includes( schema.format ?? '' );
	}
	if ( ! /[\\/]|^[.~]|\.[A-Za-z0-9]{1,8}$/.test( value ) ) {
		return false;
	}
	try {
		return statSync(
			path.resolve(
				value.startsWith( '~/' )
					? path.join( os.homedir(), value.slice( 2 ) )
					: value
			)
		).isFile();
	} catch {
		return false;
	}
}

/**
 * Works out which `field=value` arguments are files to upload. A value is a file
 * when the route's schema declares that arg `format: binary`, when it is core
 * media's `file` field, when it starts with `@` (an explicit override; `@@` escapes
 * a literal leading `@`), or — on routes with no known file field — when it is an
 * `http(s)://` URL or the path of an existing file.
 * @param opts `namespace`/`route` of the command, its parsed `fields`, every value
 *             of any repeated field (`repeated`), and the live POST `args` schema.
 * @return The plan, or undefined when no field is a file.
 */
export function planUploads(
	opts: PlanUploadsOptions
): UploadPlan | undefined {
	const known = isKnownUploadRoute( opts.namespace, opts.route );
	const textFields: Record< string, string > = {};
	const files: UploadPlan[ 'files' ] = [];
	const detected: string[] = [];
	// Once the route names its file field (schema or core media), other fields
	// are never guessed, so `--title=cat.jpg` stays text next to `--file=cat.jpg`.
	const hasKnownFileField =
		known ||
		Object.values( opts.args ?? {} ).some( ( a ) => a.format === 'binary' );
	for ( const [ key, last ] of Object.entries( opts.fields ) ) {
		const values = opts.repeated?.[ key ] ?? [ last ];
		const sources: string[] = [];
		for ( const value of values ) {
			if ( value.startsWith( '@@' ) ) {
				continue;
			}
			if ( value.startsWith( '@' ) ) {
				sources.push( value.slice( 1 ) );
			} else if (
				opts.args?.[ key ]?.format === 'binary' ||
				( known && key === 'file' )
			) {
				sources.push( value );
			} else if (
				! hasKnownFileField &&
				looksLikeFile( key, value, opts.args?.[ key ] )
			) {
				sources.push( value );
				if ( ! detected.includes( key ) ) {
					detected.push( key );
				}
			}
		}
		if ( sources.length > 0 ) {
			files.push( { field: key, sources } );
		} else {
			textFields[ key ] = last.startsWith( '@@' )
				? last.slice( 1 )
				: last;
		}
	}
	return files.length > 0 ? { textFields, files, detected } : undefined;
}

/**
 * Expands a plan into one list of `{field, source}` per request: a field given
 * several times means one request per value (a batch); other file fields ride
 * along with every request.
 * @param plan The upload plan.
 * @return The requests to send, each a list of file field/source pairs.
 */
export function expandBatches(
	plan: UploadPlan
): Array< Array< { field: string; source: string } > > {
	const multi = plan.files.filter( ( f ) => f.sources.length > 1 );
	if ( multi.length > 1 ) {
		throw new CliError(
			`Only one file field can be repeated (got: ${ multi
				.map( ( f ) => f.field )
				.join( ', ' ) }).`
		);
	}
	const single = plan.files
		.filter( ( f ) => f.sources.length === 1 )
		.map( ( f ) => ( {
			field: f.field,
			source: f.sources[ 0 ] as string,
		} ) );
	if ( ! multi[ 0 ] ) {
		return [ single ];
	}
	const batchField = multi[ 0 ].field;
	return multi[ 0 ].sources.map( ( source ) => [
		...single,
		{ field: batchField, source },
	] );
}

/**
 * Checks a local path is a readable, non-empty regular file whose size Node can
 * represent exactly, and prepares it for upload.
 * @param field  The multipart field the file will be sent under.
 * @param source The path as typed (`~/` expands to the home directory).
 * @return The prepared file.
 */
export async function prepareLocalFile(
	field: string,
	source: string
): Promise< PreparedFile > {
	if ( source === '-' || source === '' ) {
		throw new CliError(
			'Reading a file from stdin is not supported; pass a file path or URL.'
		);
	}
	const resolved = path.resolve(
		source.startsWith( '~/' )
			? path.join( os.homedir(), source.slice( 2 ) )
			: source
	);
	let info;
	try {
		info = await stat( resolved, { bigint: true } );
	} catch ( error ) {
		const code = ( error as NodeJS.ErrnoException ).code;
		throw new CliError(
			code === 'ENOENT'
				? `File doesn't exist: ${ source }`
				: `Cannot read ${ source }: ${ ( error as Error ).message }`
		);
	}
	if ( ! info.isFile() ) {
		throw new CliError( `Not a regular file: ${ source }` );
	}
	if ( info.size === 0n ) {
		throw new CliError( `File is empty: ${ source }` );
	}
	if ( info.size > BigInt( Number.MAX_SAFE_INTEGER ) ) {
		throw new CliError(
			`File is too large for Node.js to upload exactly: ${ source }`
		);
	}
	const filename = sanitizeFilename( resolved );
	if ( ! filename ) {
		throw new CliError( `Cannot determine a filename for ${ source }` );
	}
	return {
		field,
		path: resolved,
		filename,
		size: Number( info.size ),
		mimeType: mimeForFilename( filename ),
	};
}

/**
 * Whether a file's extension is allowed by the site's `allowedMimeTypes` map
 * (`{"jpg|jpeg|jpe": "image/jpeg", ...}`, keyed by `|`-joined extensions).
 * @param filename The filename to check.
 * @param allowed  The site's allowed-types map.
 * @return False only when the site definitely doesn't allow the extension.
 */
export function isExtensionAllowed(
	filename: string,
	allowed: Record< string, string >
): boolean {
	const ext = extensionOf( filename );
	if ( ! ext ) {
		return true;
	}
	return Object.keys( allowed ).some( ( key ) =>
		key.toLowerCase().split( '|' ).includes( ext )
	);
}

/**
 * Escapes a multipart header parameter value (field or file name).
 * @param value The raw value.
 * @return The value with quotes and line breaks percent-encoded.
 */
function escapeParam( value: string ): string {
	return value
		.replace( /"/g, '%22' )
		.replace( /\r/g, '%0D' )
		.replace( /\n/g, '%0A' );
}

/** Inputs to {@link uploadMultipart}. */
export interface UploadMultipartOptions {
	url: string;
	method: string;
	headers: Record< string, string >;
	textFields: Record< string, string >;
	files: PreparedFile[];
	timeoutMs?: number;
	debug: boolean;
}

/**
 * Streams a multipart/form-data POST with one or more files. Unlike `fetch`,
 * which buffers the whole body in memory, the files are piped from disk so a
 * huge upload uses flat memory, and the exact `Content-Length` is sent up front.
 * @param opts `url`, `method`, `headers` (auth etc.), `textFields`, `files`,
 *             `timeoutMs` (socket idle/response timeout) and `debug`.
 * @return The parsed JSON response.
 */
export async function uploadMultipart(
	opts: UploadMultipartOptions
): Promise< UploadResponse > {
	const boundary = `----wrapido-${ randomBytes( 12 ).toString( 'hex' ) }`;
	const chunks: Array< Buffer | PreparedFile > = [];
	for ( const [ name, value ] of Object.entries( opts.textFields ) ) {
		chunks.push(
			Buffer.from(
				`--${ boundary }\r\nContent-Disposition: form-data; name="${ escapeParam(
					name
				) }"\r\n\r\n${ value }\r\n`
			)
		);
	}
	for ( const file of opts.files ) {
		chunks.push(
			Buffer.from(
				`--${ boundary }\r\nContent-Disposition: form-data; name="${ escapeParam(
					file.field
				) }"; filename="${ escapeParam(
					file.filename
				) }"\r\nContent-Type: ${ file.mimeType }\r\n\r\n`
			),
			file,
			Buffer.from( '\r\n' )
		);
	}
	chunks.push( Buffer.from( `--${ boundary }--\r\n` ) );
	const length = chunks.reduce(
		( sum, chunk ) =>
			sum + ( Buffer.isBuffer( chunk ) ? chunk.length : chunk.size ),
		0
	);

	const headers = {
		Accept: 'application/json',
		...opts.headers,
		'Content-Type': `multipart/form-data; boundary=${ boundary }`,
		'Content-Length': String( length ),
	};
	const target = new URL( opts.url );
	const timeoutMs = opts.timeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS;

	if ( opts.debug ) {
		debugLog( `→ ${ opts.method } ${ target.toString() }` );
		for ( const [ key, value ] of Object.entries(
			redactHeaders( headers )
		) ) {
			debugLog( `  ${ key }: ${ value }` );
		}
		const fileSummary = opts.files
			.map( ( f ) => `${ f.field }=${ f.filename } (${ f.size } bytes)` )
			.join( ', ' );
		const textSummary = redactBody(
			new URLSearchParams( opts.textFields ).toString(),
			'application/x-www-form-urlencoded'
		);
		debugLog(
			`  body: <multipart: ${ fileSummary }${
				textSummary ? `; ${ textSummary }` : ''
			}>`
		);
	}

	async function* body(): AsyncGenerator< Buffer > {
		for ( const chunk of chunks ) {
			if ( Buffer.isBuffer( chunk ) ) {
				arm();
				yield chunk;
			} else {
				let sent = 0;
				for await ( const data of createReadStream( chunk.path ) ) {
					sent += ( data as Buffer ).length;
					arm();
					yield data as Buffer;
				}
				if ( sent !== chunk.size ) {
					throw new CliError(
						`${ chunk.filename } changed size while uploading (expected ${ chunk.size } bytes, read ${ sent }).`
					);
				}
			}
		}
	}

	// Idle timeout via AbortController: re-armed whenever bytes move in either
	// direction, so a big upload that keeps progressing is never cut off.
	const controller = new AbortController();
	let timer: NodeJS.Timeout | undefined;
	const arm = () => {
		clearTimeout( timer );
		timer = setTimeout( () => controller.abort(), timeoutMs );
		timer.unref();
	};
	const timedOut = () =>
		new CliError(
			`The upload timed out after ${ Math.round(
				timeoutMs / 1000
			) }s without any activity. Use --timeout to allow longer.`
		);
	arm();

	const startedAt = Date.now();
	const request = ( target.protocol === 'https:' ? https : http ).request(
		target,
		{ method: opts.method, headers, signal: controller.signal }
	);
	let responded = false;
	// Persistent: a socket error after the response head arrived (server
	// answered early and reset) must not become an unhandled 'error' event.
	request.on( 'error', () => undefined );
	const responsePromise = new Promise< http.IncomingMessage >(
		( resolve, reject ) => {
			request.once( 'response', ( res ) => {
				responded = true;
				arm();
				resolve( res );
			} );
			request.on( 'error', ( error ) => {
				if ( ! responded ) {
					reject( error.name === 'AbortError' ? timedOut() : error );
				}
			} );
		}
	);
	pipeline( Readable.from( body(), { objectMode: false } ), request ).catch(
		( error: Error ) => {
			// An early response (413, 401...) is the real answer; keep it.
			if ( ! responded ) {
				request.destroy( error );
			}
		}
	);

	let response: http.IncomingMessage;
	try {
		response = await responsePromise;
	} catch ( error ) {
		const code = ( error as NodeJS.ErrnoException ).code ?? '';
		if ( HANG_UP_CODES.has( code ) ) {
			throw new CliError(
				'The server closed the connection before the upload finished (the file may exceed a server size limit).'
			);
		}
		throw error instanceof CliError
			? error
			: new CliError( `Upload failed: ${ ( error as Error ).message }` );
	}

	const text = await new Promise< string >( ( resolve, reject ) => {
		const parts: Buffer[] = [];
		response.on( 'data', ( part: Buffer ) => {
			arm();
			parts.push( part );
		} );
		const done = () => {
			clearTimeout( timer );
			resolve( Buffer.concat( parts ).toString() );
		};
		response.on( 'end', done );
		// A reset after the head/partial body still leaves a usable status.
		const finish = () => {
			if ( controller.signal.aborted ) {
				clearTimeout( timer );
				reject( timedOut() );
				return;
			}
			done();
		};
		response.on( 'error', finish );
		response.on( 'aborted', finish );
	} );
	const status = response.statusCode ?? 0;
	const responseHeaders = new Headers();
	for ( const [ key, value ] of Object.entries( response.headers ) ) {
		if ( value !== undefined ) {
			responseHeaders.set(
				key,
				Array.isArray( value ) ? value.join( ', ' ) : value
			);
		}
	}
	if ( opts.debug ) {
		debugLog(
			`← ${ status } ${ response.statusMessage ?? '' } (${
				Date.now() - startedAt
			}ms)`
		);
	}
	if ( status >= 300 && status < 400 ) {
		throw new CliError(
			`The server redirected the upload${
				responseHeaders.get( 'location' )
					? ` to ${ responseHeaders.get( 'location' ) }`
					: ''
			}. Use the final URL for --url.`
		);
	}
	if ( status < 200 || status >= 300 ) {
		throw await parseErrorResponse(
			new Response( text || null, { status, headers: responseHeaders } )
		);
	}
	try {
		return {
			status,
			headers: responseHeaders,
			body: text ? JSON.parse( text ) : undefined,
		};
	} catch {
		throw new CliError(
			`The server's response was not valid JSON: ${ text.slice(
				0,
				200
			) }`
		);
	}
}
