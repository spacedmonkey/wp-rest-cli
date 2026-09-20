/**
 * Internal dependencies
 */
import type { WpRestClient } from '../core/client.js';
import { downloadToTemp, isUrl } from '../core/download.js';
import { CliError, formatErrorForDisplay } from '../core/errors.js';
import { followCreatedLocation } from '../core/follow-location.js';
import { formatOutput } from '../core/formatter.js';
import {
	expandBatches,
	isExtensionAllowed,
	prepareLocalFile,
	uploadMultipart,
	type PreparedFile,
	type UploadPlan,
} from '../core/upload.js';
import type { GlobalFlags } from '../types.js';
import { createProgressBar, notice, pc, warn, withSpinner } from '../ui.js';

/** How many times to retry sub-size generation after a 5xx that created the attachment. */
const POST_PROCESS_ATTEMPTS = 5;

/** Pause between sub-size generation retries, in milliseconds. */
const POST_PROCESS_DELAY_MS = 250;

/** Everything an upload command needs, resolved by the dispatcher. */
export interface UploadCommandOptions {
	client: WpRestClient;
	apiRoot: string;
	namespace: string;
	route: string;
	verb: 'create' | 'update';
	/** The request URL for one upload (collection URL, or the item URL for `update`). */
	url: string;
	plan: UploadPlan;
	/** Non-file fields, already JSON-coerced against the route's schema. */
	textFields: Record< string, unknown >;
	flags: GlobalFlags;
}

/**
 * Flattens a coerced field into multipart text parts. WordPress doesn't JSON-decode
 * multipart values, so arrays/objects use PHP-style bracketed names
 * (`categories[0]=1`, `meta[key]=v`), which PHP parses back into arrays.
 * @param name  The form field name.
 * @param value The coerced field value.
 * @param out   The map to add the resulting parts to.
 */
function addFormParts(
	name: string,
	value: unknown,
	out: Record< string, string >
): void {
	if ( Array.isArray( value ) ) {
		value.forEach( ( item, index ) =>
			addFormParts( `${ name }[${ index }]`, item, out )
		);
	} else if ( value !== null && typeof value === 'object' ) {
		for ( const [ key, item ] of Object.entries( value ) ) {
			addFormParts( `${ name }[${ key }]`, item, out );
		}
	} else {
		out[ name ] = String( value ?? '' );
	}
}

/**
 * Waits between post-process retries.
 * @param ms Milliseconds to wait.
 */
function delay( ms: number ): Promise< void > {
	return new Promise( ( resolve ) => setTimeout( resolve, ms ) );
}

/**
 * Fetches the site's allowed upload extensions, best-effort: the only place
 * WordPress exposes them over REST is the Gutenberg plugin's block-editor
 * settings route, so any failure (404, 403, unexpected shape) means "unknown".
 * @param client  The REST client.
 * @param apiRoot The resolved REST API root URL.
 * @return The `{"jpg|jpeg": "image/jpeg", ...}` map, or undefined when unavailable.
 */
async function fetchAllowedMimeTypes(
	client: WpRestClient,
	apiRoot: string
): Promise< Record< string, string > | undefined > {
	try {
		const { body } = await client.request< {
			allowedMimeTypes?: Record< string, string >;
		} >( new URL( 'wp-block-editor/v1/settings', apiRoot ).toString() );
		const allowed = body?.allowedMimeTypes;
		return allowed &&
			typeof allowed === 'object' &&
			! Array.isArray( allowed )
			? allowed
			: undefined;
	} catch {
		return undefined;
	}
}

/**
 * Whether the current user may upload any file type (`unfiltered_upload`),
 * in which case the site's allowed-types list doesn't apply to them.
 * @param client  The REST client.
 * @param apiRoot The resolved REST API root URL.
 * @return True only when the capability is confirmed.
 */
async function hasUnfilteredUpload(
	client: WpRestClient,
	apiRoot: string
): Promise< boolean > {
	try {
		const url = new URL( 'wp/v2/users/me', apiRoot );
		url.searchParams.set( 'context', 'edit' );
		const { body } = await client.request< {
			capabilities?: Record< string, boolean >;
		} >( url.toString() );
		return body?.capabilities?.unfiltered_upload === true;
	} catch {
		return false;
	}
}

/**
 * Runs `create`/`update` with one or more file fields as multipart uploads:
 * a single file behaves like any other create (spinner, thrown errors), while
 * several files (a repeated field) run one request each, report each failure,
 * and exit 1 if any failed.
 * @param opts The resolved command.
 * @return The command's rendered output and exit code.
 */
export async function runUploadCommand(
	opts: UploadCommandOptions
): Promise< { output: string; exitCode: number } > {
	const { client, apiRoot, flags } = opts;
	if ( flags.body !== undefined ) {
		throw new CliError( '--body cannot be combined with a file upload.' );
	}
	const requests = expandBatches( opts.plan );
	if ( opts.verb === 'update' && requests.length > 1 ) {
		throw new CliError( 'Only one file can be sent with "update".' );
	}

	const target = new URL( apiRoot );
	if (
		target.protocol === 'http:' &&
		! [ 'localhost', '127.0.0.1', '[::1]' ].includes( target.hostname )
	) {
		notice(
			'This site uses plain http://; your credentials and the file are sent unencrypted.',
			! flags.quiet
		);
	}

	if ( opts.plan.detected.length > 0 ) {
		console.error(
			warn(
				`Treating ${ opts.plan.detected
					.map( ( f ) => `--${ f }` )
					.join(
						', '
					) } as a file to upload (detected from its value). Use @@ to send a literal value instead.`
			)
		);
	}

	const progress = ! flags.quiet && ! flags.debug;
	const textFields: Record< string, string > = {};
	for ( const [ key, value ] of Object.entries( opts.textFields ) ) {
		addFormParts( key, value, textFields );
	}

	let allowedMimes: Record< string, string > | undefined;
	let allowedLoaded = false;
	let unfiltered: boolean | undefined;

	/**
	 * Refuses a file the site says it doesn't allow (skipped for users who may
	 * upload anything, and whenever the site's list can't be discovered).
	 * @param files The files about to be uploaded.
	 */
	async function checkAllowedTypes( files: PreparedFile[] ): Promise< void > {
		if ( ! allowedLoaded ) {
			allowedLoaded = true;
			allowedMimes = await fetchAllowedMimeTypes( client, apiRoot );
		}
		if ( ! allowedMimes ) {
			return;
		}
		for ( const file of files ) {
			if ( isExtensionAllowed( file.filename, allowedMimes ) ) {
				continue;
			}
			unfiltered ??= await hasUnfilteredUpload( client, apiRoot );
			if ( unfiltered ) {
				return;
			}
			throw new CliError(
				`This site does not allow uploading "${ file.filename }" (file type not in its allowed list).`
			);
		}
	}

	/**
	 * Resolves each source to a local file, downloading URLs first (with a
	 * progress bar).
	 * @param sources  The `{field, source}` pairs for one request.
	 * @param cleanups Collects the temp-dir cleanups to run afterwards.
	 * @return The files, ready to upload.
	 */
	async function prepare(
		sources: Array< { field: string; source: string } >,
		cleanups: Array< () => Promise< void > >
	): Promise< PreparedFile[] > {
		const files: PreparedFile[] = [];
		for ( const { field, source } of sources ) {
			if ( isUrl( source ) ) {
				const downloaded = await downloadToTemp( source, {
					timeoutMs: flags.timeout,
					progress,
				} );
				cleanups.push( downloaded.cleanup );
				if ( downloaded.size === 0 ) {
					throw new CliError(
						`Downloaded file is empty: ${ source }`
					);
				}
				files.push( { field, ...downloaded } );
			} else {
				files.push( await prepareLocalFile( field, source ) );
			}
		}
		await checkAllowedTypes( files );
		return files;
	}

	// Set once a create's Location was followed; then the item is shown, not a Success line.
	let followedAny = false;

	/**
	 * Sends one upload. If the server created the attachment but crashed while
	 * generating image sizes (a 5xx carrying `X-WP-Upload-Attachment-ID`), retries
	 * sub-size generation, and removes the orphaned attachment if that keeps failing.
	 * @param files The prepared files for this request.
	 * @return The created/updated item.
	 */
	async function send( files: PreparedFile[] ): Promise< unknown > {
		const headers = await client.authHeaders();
		try {
			const response = await uploadMultipart( {
				url: opts.url,
				method: 'POST',
				headers,
				textFields,
				files,
				timeoutMs: flags.timeout,
				debug: flags.debug,
			} );
			// Only a create has a canonical Location to follow.
			const followed =
				opts.verb === 'create'
					? await followCreatedLocation(
							client,
							apiRoot,
							response,
							flags
					  )
					: undefined;
			followedAny ||= !! followed;
			return followed ? followed.body : response.body;
		} catch ( error ) {
			const failure = error as { headers?: Headers; status?: number };
			const id = failure.headers?.get( 'x-wp-upload-attachment-id' );
			if (
				( failure.status ?? 0 ) < 500 ||
				! id ||
				! /^\d+$/.test( id )
			) {
				throw error;
			}
			const item = new URL( `wp/v2/media/${ id }`, apiRoot ).toString();
			for (
				let attempt = 1;
				attempt <= POST_PROCESS_ATTEMPTS;
				attempt++
			) {
				try {
					const { body } = await client.request(
						`${ item }/post-process`,
						{
							method: 'POST',
							body: { action: 'create-image-subsizes' },
						}
					);
					return body;
				} catch {
					await delay( POST_PROCESS_DELAY_MS );
				}
			}
			await client
				.request( item, { method: 'DELETE', query: { force: true } } )
				.catch( () => undefined );
			throw new CliError(
				'The upload failed while WordPress was generating image sizes, and the partly created attachment was removed. If this is a photo or a large image, scale it down and try again.'
			);
		}
	}

	const routeLabel = `${ opts.namespace }/${ opts.route }`;
	const created: unknown[] = [];
	let failures = 0;

	if ( requests.length === 1 ) {
		const cleanups: Array< () => Promise< void > > = [];
		try {
			const files = await prepare( requests[ 0 ] ?? [], cleanups );
			created.push(
				await withSpinner( `POST ${ routeLabel }`, ! flags.quiet, () =>
					send( files )
				)
			);
		} finally {
			await Promise.all( cleanups.map( ( cleanup ) => cleanup() ) );
		}
	} else {
		// Downloads draw their own bars, so the batch bar is only used when
		// every source is a local file.
		const hasUrls = requests.some( ( r ) =>
			r.some( ( s ) => isUrl( s.source ) )
		);
		const bar = createProgressBar(
			`Uploading ${ routeLabel }`,
			hasUrls ? 0 : requests.length,
			progress
		);
		const say = ( message: string ) =>
			bar === undefined || hasUrls || ! progress
				? console.error( message )
				: bar.log( message );
		for ( const [ index, sources ] of requests.entries() ) {
			const label = sources.map( ( s ) => s.source ).join( ', ' );
			if ( hasUrls ) {
				notice(
					`[${ index + 1 }/${ requests.length }] ${ label }`,
					progress
				);
			}
			const cleanups: Array< () => Promise< void > > = [];
			try {
				const files = await prepare( sources, cleanups );
				created.push( await send( files ) );
			} catch ( error ) {
				failures++;
				say( `${ label }: ${ formatErrorForDisplay( error ) }` );
			} finally {
				await Promise.all( cleanups.map( ( cleanup ) => cleanup() ) );
				bar.tick();
			}
		}
		bar.finish();
	}

	if ( failures > 0 ) {
		console.error(
			warn( `${ failures } of ${ requests.length } uploads failed.` )
		);
	}
	const exitCode = failures > 0 ? 1 : 0;
	if ( created.length === 0 ) {
		return { output: '', exitCode: 1 };
	}
	if (
		! followedAny &&
		flags.format === 'table' &&
		! flags.field &&
		! flags.fields
	) {
		const ids = created
			.map(
				( item ) => ( item as { id?: unknown } | undefined )?.id ?? ''
			)
			.join( ' ' );
		const verbLabel = opts.verb === 'create' ? 'Created' : 'Updated';
		return {
			output: pc.green(
				created.length === 1
					? `Success: ${ verbLabel } ${ opts.route } ${ ids }.`
					: `Success: ${ verbLabel.toLowerCase() } ${
							created.length
					  } ${ opts.route }: ${ ids }`
			),
			exitCode,
		};
	}
	const output = await formatOutput(
		created.length === 1 ? created[ 0 ] : created,
		{
			format: flags.format,
			fields: flags.fields,
			field: flags.field,
			color: flags.color,
		}
	);
	return { output, exitCode };
}
