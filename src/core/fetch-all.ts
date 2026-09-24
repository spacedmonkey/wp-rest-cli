/**
 * Internal dependencies
 */
import type { WpRestClient, WpResponse } from './client.js';
import { createProgressBar, withSpinner } from '../ui.js';

// ponytail: fixed concurrency; make configurable if a site throttles.
const CONCURRENCY = 5;

/**
 * Reads the `rel="next"` target out of a `Link` response header.
 * @param headers The response headers.
 * @return The next page's URL, or `undefined` on the last page.
 */
export function nextLink( headers: Headers ): string | undefined {
	return headers
		.get( 'link' )
		?.split( ',' )
		.map( ( part ) => part.match( /<([^>]+)>\s*;\s*rel="?next"?/ ) )
		.find( Boolean )?.[ 1 ];
}

/**
 * Emulates `per_page=-1` (which the REST API rejects) the way Gutenberg's
 * `fetch-all-middleware` does: requests every page at `perPage` and
 * concatenates them. Uses `X-WP-TotalPages` to fetch the remaining pages in
 * parallel, falling back to following `Link: rel="next"` one page at a time
 * for routes that don't send it.
 * Shows a spinner for page 1, then a per-page progress bar once the total is
 * known (just the spinner when following `Link`, which has no total).
 * @param client       The REST client (carries auth).
 * @param url          The list request's URL; its `per_page`/`page` are overridden.
 * @param perPage      The page size to request, normally the route's maximum.
 * @param label        The spinner/progress bar message.
 * @param showProgress Whether to show progress output (typically `! flags.quiet`).
 * @return The first page's response, with every page's rows as its body.
 */
export async function fetchAllPages(
	client: WpRestClient,
	url: string,
	perPage: number,
	label: string,
	showProgress: boolean
): Promise< WpResponse > {
	const page = async ( n: number ) =>
		client.request( url, { query: { per_page: perPage, page: n } } );
	const first = await withSpinner( label, showProgress, () => page( 1 ) );
	if ( ! Array.isArray( first.body ) ) {
		return first;
	}
	const rows: unknown[] = [ ...first.body ];
	// A missing, empty or non-numeric X-WP-TotalPages falls back to
	// following `Link`, rather than silently returning page 1 only.
	const totalPages = Number( first.headers.get( 'x-wp-totalpages' ) || NaN );
	if ( totalPages > 1 ) {
		const progress = createProgressBar( label, totalPages, showProgress );
		progress.tick();
		try {
			for ( let start = 2; start <= totalPages; start += CONCURRENCY ) {
				const batch = [];
				for (
					let n = start;
					n < start + CONCURRENCY && n <= totalPages;
					n++
				) {
					batch.push(
						page( n ).then( ( response ) => {
							progress.tick();
							return response;
						} )
					);
				}
				for ( const response of await Promise.all( batch ) ) {
					rows.push( ...( response.body as unknown[] ) );
				}
			}
		} finally {
			progress.finish();
		}
	} else if ( ! Number.isFinite( totalPages ) ) {
		await withSpinner(
			`${ label } (following next links)`,
			showProgress,
			async () => {
				const seen = new Set< string >();
				let next = nextLink( first.headers );
				// `seen` guards against a misbehaving plugin linking back to itself.
				while ( next && ! seen.has( next ) ) {
					seen.add( next );
					const response = await client.request( next );
					if ( ! Array.isArray( response.body ) ) {
						break;
					}
					rows.push( ...response.body );
					next = nextLink( response.headers );
				}
			}
		);
	}
	return { ...first, body: rows };
}
