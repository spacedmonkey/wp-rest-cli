/**
 * WordPress dependencies
 */
import { addQueryArgs } from '@wordpress/url';

/**
 * Internal dependencies
 */
import type { WpRestClient, WpResponse } from './client.js';
import type { GlobalFlags } from '../types.js';

/**
 * After a `create`, follows the 201 response's same-origin `Location` header
 * and returns that canonical resource instead of the POST body. Returns
 * `undefined` (caller keeps the POST response) if there's no Location, it's
 * another origin, or the GET fails.
 * @param client   The REST client (carries auth).
 * @param apiRoot  The site's REST API root; Location must share its origin.
 * @param response The create request's response.
 * @param flags    Global CLI flags.
 * @return The fetched resource wrapped in `{ body }`, or `undefined`.
 */
export async function followCreatedLocation(
	client: WpRestClient,
	apiRoot: string,
	response: WpResponse,
	flags: GlobalFlags
): Promise< { body: unknown } | undefined > {
	const location = response.headers.get( 'location' );
	if ( response.status !== 201 || ! location ) {
		return undefined;
	}
	try {
		const target = new URL( location, apiRoot );
		if ( target.origin !== new URL( apiRoot ).origin ) {
			return undefined;
		}
		// Only the user's own --context: not every route declares `edit`.
		const { body } = await client.request(
			flags.context
				? addQueryArgs( target.toString(), { context: flags.context } )
				: target.toString()
		);
		return { body };
	} catch ( error ) {
		if ( ! flags.quiet ) {
			// Server-controlled text: strip control chars before printing.
			const reason = (
				error instanceof Error ? error.message : String( error )
			).replace( /[\u0000-\u001f\u007f]/g, ' ' );
			process.stderr.write(
				`Warning: created, but fetching the new item failed: ${ reason }\n`
			);
		}
		return undefined;
	}
}
