/**
 * External dependencies
 */
import { createWriteStream, rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/**
 * Internal dependencies
 */
import { createProgressBar, spinner } from '../ui.js';
import { CliError } from './errors.js';
import {
	DEFAULT_MIME_TYPE,
	extensionForMime,
	extensionOf,
	mimeForFilename,
} from './mime.js';
import { resolveTimeout, timedFetch } from './timeout.js';

/** Default download timeout, matching WP-CLI's `download_url`. */
const DEFAULT_TIMEOUT_MS = 300_000;

/** A remote file that has been downloaded into a temp directory. */
export interface DownloadedFile {
	path: string;
	filename: string;
	size: number;
	mimeType: string;
	/** Deletes the temp directory; safe to call more than once. */
	cleanup: () => Promise< void >;
}

const tempDirs = new Set< string >();
let exitHooksInstalled = false;

/** Removes every temp dir still on disk; used by the exit/signal hooks. */
function cleanupAllSync(): void {
	for ( const dir of tempDirs ) {
		rmSync( dir, { recursive: true, force: true } );
	}
	tempDirs.clear();
}

/** Makes sure temp downloads are removed even on Ctrl-C or an early process exit. */
function installExitHooks(): void {
	if ( exitHooksInstalled ) {
		return;
	}
	exitHooksInstalled = true;
	process.on( 'exit', cleanupAllSync );
	for ( const signal of [ 'SIGINT', 'SIGTERM' ] as const ) {
		process.once( signal, () => {
			cleanupAllSync();
			process.exit( signal === 'SIGINT' ? 130 : 143 );
		} );
	}
}

/**
 * Whether a value is an http(s) URL.
 * @param value The candidate string.
 * @return True for `http://` / `https://` values.
 */
export function isUrl( value: string ): boolean {
	return /^https?:\/\//i.test( value );
}

/**
 * Reduces a candidate filename to a safe basename (no directories, no control characters).
 * @param name The raw filename.
 * @return The sanitized filename, or an empty string when nothing usable remains.
 */
export function sanitizeFilename( name: string ): string {
	const clean = path.win32
		.basename( name )
		.replace( /[\u0000-\u001f\u007f]/g, '' )
		.trim();
	return clean === '.' || clean === '..' ? '' : clean;
}

/**
 * Picks the filename for a downloaded file: `Content-Disposition` first, then the
 * URL's last path segment (query string stripped), then `download`; when the result
 * has no extension, one is derived from the response `Content-Type`.
 * @param url                The source URL.
 * @param contentDisposition The response's `Content-Disposition` header, if any.
 * @param contentType        The response's `Content-Type` header, if any.
 * @return The filename to upload under.
 */
export function deriveDownloadFilename(
	url: string,
	contentDisposition: string | null,
	contentType: string | null
): string {
	let name = '';
	if ( contentDisposition ) {
		const star = /(?:^|;)\s*filename\*\s*=\s*[^']*'[^']*'([^;]+)/i.exec(
			contentDisposition
		);
		const plain = /(?:^|;)\s*filename\s*=\s*(?:"([^"]*)"|([^;]+))/i.exec(
			contentDisposition
		);
		if ( star?.[ 1 ] ) {
			try {
				name = decodeURIComponent( star[ 1 ].trim() );
			} catch {
				name = star[ 1 ].trim();
			}
		} else if ( plain ) {
			name = ( plain[ 1 ] ?? plain[ 2 ] ?? '' ).trim();
		}
	}
	if ( ! sanitizeFilename( name ) ) {
		const segment = new URL( url ).pathname.split( '/' ).pop() ?? '';
		try {
			name = decodeURIComponent( segment );
		} catch {
			name = segment;
		}
	}
	name = sanitizeFilename( name ) || 'download';
	if ( ! extensionOf( name ) && contentType ) {
		const ext = extensionForMime( contentType );
		if ( ext ) {
			name = `${ name }.${ ext }`;
		}
	}
	return name;
}

/**
 * Downloads an http(s) URL into a fresh temp directory, streaming it to disk with
 * a progress bar. No WordPress credentials are ever sent to the source host.
 * @param url            The http(s) URL to fetch.
 * @param opts           `timeoutMs` (default 300s) and `progress` (show the bar/spinner).
 * @param opts.timeoutMs
 * @param opts.progress
 * @return The downloaded file; the caller must call `cleanup()`.
 */
export async function downloadToTemp(
	url: string,
	opts: { timeoutMs?: number; progress: boolean }
): Promise< DownloadedFile > {
	if ( ! isUrl( url ) ) {
		throw new CliError(
			`Unable to download '${ url }'. Only http:// and https:// URLs are supported.`
		);
	}
	const fail = ( reason: string ) =>
		new CliError( `Unable to download '${ url }'. Reason: ${ reason }` );

	// Idle timeout: re-armed on every received chunk, so a large download that
	// keeps progressing isn't cut off.
	const timeoutMs = resolveTimeout( opts.timeoutMs ?? DEFAULT_TIMEOUT_MS );
	const controller = new AbortController();
	let timer: NodeJS.Timeout | undefined;
	const arm = () => {
		clearTimeout( timer );
		timer = setTimeout(
			() => controller.abort( new Error( 'the download timed out' ) ),
			timeoutMs
		);
	};
	arm();

	let response: Response;
	try {
		response = await timedFetch( url, {
			redirect: 'follow',
			headers: {
				// The byte count for the progress bar must match what's written.
				'Accept-Encoding': 'identity',
				'User-Agent': 'wrapido',
			},
			signal: controller.signal,
		} );
	} catch ( error ) {
		clearTimeout( timer );
		throw fail( ( error as Error ).message );
	}
	if (
		url.toLowerCase().startsWith( 'https:' ) &&
		new URL( response.url ).protocol !== 'https:'
	) {
		clearTimeout( timer );
		await response.body?.cancel();
		throw fail( 'the server redirected from https to http.' );
	}
	if ( ! response.ok || ! response.body ) {
		clearTimeout( timer );
		await response.body?.cancel();
		throw fail(
			`HTTP ${ response.status } ${ response.statusText }.`.trim()
		);
	}

	const filename = deriveDownloadFilename(
		url,
		response.headers.get( 'content-disposition' ),
		response.headers.get( 'content-type' )
	);
	const dir = await mkdtemp( path.join( os.tmpdir(), 'wrapido-' ) );
	tempDirs.add( dir );
	installExitHooks();
	const cleanup = async () => {
		tempDirs.delete( dir );
		await rm( dir, { recursive: true, force: true } );
	};
	const filePath = path.join( dir, filename );

	const total = Number( response.headers.get( 'content-length' ) );
	const label = `Downloading ${ filename }`;
	const bar =
		total > 0
			? createProgressBar( label, total, opts.progress )
			: undefined;
	const spin = bar ? undefined : spinner( label, opts.progress );
	let received = 0;
	const counter = new Transform( {
		transform( chunk: Buffer, _encoding, callback ) {
			received += chunk.length;
			arm();
			bar?.tick( chunk.length );
			if ( spin ) {
				spin.text = `${ label } (${ ( received / 1_048_576 ).toFixed(
					1
				) } MB)`;
			}
			callback( null, chunk );
		},
	} );
	try {
		await pipeline(
			Readable.fromWeb( response.body as never ),
			counter,
			createWriteStream( filePath )
		);
		spin?.succeed( label );
	} catch ( error ) {
		spin?.fail( label );
		await cleanup();
		throw fail( ( error as Error ).message );
	} finally {
		clearTimeout( timer );
		bar?.finish();
	}

	const headerType = response.headers
		.get( 'content-type' )
		?.split( ';' )[ 0 ]
		?.trim();
	return {
		path: filePath,
		filename,
		size: received,
		mimeType:
			headerType && headerType !== DEFAULT_MIME_TYPE
				? headerType
				: mimeForFilename( filename ),
		cleanup,
	};
}
