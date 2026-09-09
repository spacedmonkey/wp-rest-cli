/**
 * WordPress dependencies
 */
import { prependHTTPS } from '@wordpress/url';

/**
 * Internal dependencies
 */
import { debugLog } from './debug.js';
import { CliError } from './errors.js';

const LINK_REL = 'https://api.w.org/';

/**
 * Extracts the `rel="https://api.w.org/"` target from an HTTP `Link` header.
 * @param header The raw `Link` header value, or null if absent.
 * @return The REST API root URL, if the header names one.
 */
function parseLinkHeader( header: string | null ): string | undefined {
	if ( ! header ) {
		return undefined;
	}
	// Link: <https://example.com/wp-json/>; rel="https://api.w.org/"
	for ( const part of header.split( ',' ) ) {
		const match = part.match( /<([^>]+)>\s*;\s*rel="([^"]+)"/ );
		if ( match && match[ 2 ] === LINK_REL && match[ 1 ] ) {
			return match[ 1 ];
		}
	}
	return undefined;
}

/**
 * Fallback for sites that omit the `Link` header: reads the equivalent
 * `<link rel="https://api.w.org/">` tag out of the page's HTML.
 * @param html The response body of the site's homepage.
 * @return The REST API root URL, if the tag is present.
 */
function parseHtmlLinkTag( html: string ): string | undefined {
	const regex = /<link[^>]+rel=["']https:\/\/api\.w\.org\/["'][^>]*>/i;
	const tagMatch = html.match( regex );
	if ( ! tagMatch ) {
		return undefined;
	}
	const hrefMatch = tagMatch[ 0 ].match( /href=["']([^"']+)["']/i );
	return hrefMatch?.[ 1 ];
}

/**
 * Checks whether `url` is a working REST API root by GETing it and looking
 * for a `routes` key in the JSON body.
 * @param url   The candidate REST API root URL.
 * @param debug Whether to log the probe request/response.
 * @return Whether `url` looks like a REST API index response.
 */
async function probe( url: string, debug: boolean ): Promise< boolean > {
	if ( debug ) {
		debugLog( `→ GET ${ url }` );
	}
	try {
		const res = await fetch( url, { signal: AbortSignal.timeout( 8000 ) } );
		if ( debug ) {
			debugLog( `← ${ res.status } ${ res.statusText }` );
		}
		if ( ! res.ok ) {
			return false;
		}
		const body = ( await res.json().catch( () => null ) ) as {
			routes?: unknown;
		} | null;
		return Boolean( body && typeof body === 'object' && 'routes' in body );
	} catch ( error ) {
		if ( debug ) {
			debugLog(
				`  failed: ${
					error instanceof Error ? error.message : String( error )
				}`
			);
		}
		return false;
	}
}

/**
 * Resolve a bare site URL (e.g. "example.com") to its REST API root
 * (e.g. "https://example.com/wp-json/"), following the standard WordPress
 * discovery algorithm: HEAD Link header -> HTML <link> tag -> conventional
 * /wp-json/ path -> ?rest_route=/ path (non-pretty-permalink sites).
 * @param siteUrl The bare site URL or hostname, as given by the user.
 * @param debug   Whether to log each discovery attempt.
 * @return The resolved REST API root URL.
 */
export async function resolveApiRoot(
	siteUrl: string,
	debug = false
): Promise< string > {
	const baseUrl = prependHTTPS( siteUrl.trim() );

	try {
		if ( debug ) {
			debugLog( `→ HEAD ${ baseUrl }` );
		}
		const headRes = await fetch( baseUrl, {
			method: 'HEAD',
			signal: AbortSignal.timeout( 8000 ),
		} );
		if ( debug ) {
			debugLog( `← ${ headRes.status } ${ headRes.statusText }` );
		}
		const fromHeader = parseLinkHeader( headRes.headers.get( 'link' ) );
		if ( fromHeader ) {
			return fromHeader;
		}
	} catch ( error ) {
		if ( debug ) {
			debugLog(
				`  failed: ${
					error instanceof Error ? error.message : String( error )
				}`
			);
		}
		// ignore, fall through to next strategy
	}

	try {
		if ( debug ) {
			debugLog( `→ GET ${ baseUrl }` );
		}
		const getRes = await fetch( baseUrl, {
			signal: AbortSignal.timeout( 8000 ),
		} );
		if ( debug ) {
			debugLog( `← ${ getRes.status } ${ getRes.statusText }` );
		}
		const fromHeader = parseLinkHeader( getRes.headers.get( 'link' ) );
		if ( fromHeader ) {
			return fromHeader;
		}
		const html = await getRes.text();
		const fromHtml = parseHtmlLinkTag( html );
		if ( fromHtml ) {
			return fromHtml;
		}
	} catch ( error ) {
		if ( debug ) {
			debugLog(
				`  failed: ${
					error instanceof Error ? error.message : String( error )
				}`
			);
		}
		// ignore, fall through to next strategy
	}

	const conventional = new URL( '/wp-json/', baseUrl ).toString();
	if ( await probe( conventional, debug ) ) {
		return conventional;
	}

	const restRoute = new URL( '/?rest_route=/', baseUrl ).toString();
	if ( await probe( restRoute, debug ) ) {
		return restRoute;
	}

	throw new CliError(
		`Couldn't auto-discover the WordPress REST API for ${ baseUrl }. ` +
			`Tried the Link header, the HTML <link rel="https://api.w.org/"> tag, ` +
			`${ conventional }, and ${ restRoute }.`
	);
}
