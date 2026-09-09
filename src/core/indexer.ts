/**
 * Internal dependencies
 */
import type { WpRestClient } from './client.js';
import type { IndexResponse, Verb } from '../types.js';

/**
 * Fetches the site's root REST API index (namespaces, routes, and site metadata).
 * @param client  The REST client to issue the request with.
 * @param apiRoot The resolved REST API root URL.
 * @return The parsed index response.
 */
export async function fetchIndex(
	client: WpRestClient,
	apiRoot: string
): Promise< IndexResponse > {
	const { body } = await client.request< IndexResponse >( apiRoot );
	return body;
}

/**
 * Strips a trailing /(?P<name>...) URL parameter segment, if the path ends with one.
 * @param path A route path, as it appears in the index's `routes` map.
 * @return `path` with any trailing regex parameter segment removed.
 */
export function stripTrailingPlaceholder( path: string ): string {
	return path.replace( /\/\(\?P<[^>]+>[^)]*\)$/, '' );
}

/**
 * Routes registered under a namespace, keyed by their path relative to the namespace.
 * @param index     The site's root REST API index.
 * @param namespace The namespace to list routes for (e.g. `wp/v2`).
 * @return Each route's raw index path and its CLI-addressable route name.
 */
export function routesForNamespace(
	index: IndexResponse,
	namespace: string
): Array< { path: string; route: string } > {
	const prefix = `/${ namespace }/`;
	const paths = Object.keys( index.routes );
	const results: Array< { path: string; route: string } > = [];
	for ( const path of paths ) {
		if ( path === `/${ namespace }` ) {
			continue;
		} // the namespace root itself
		if ( ! path.startsWith( prefix ) ) {
			continue;
		}

		if ( path.includes( '(?P<' ) ) {
			// Typical WP pattern: a bare collection (e.g. /posts) plus a singular
			// variant ending in a parameter (e.g. /posts/(?P<id>[\d]+)) — the latter
			// is reached via `get <id>` / `update <id>` / `delete <id>` on the bare
			// route, not addressed directly, so skip it here.
			const basePath = stripTrailingPlaceholder( path );
			if ( basePath === path || paths.includes( basePath ) ) {
				continue;
			}
			// Some routes (e.g. WP_REST_Global_Styles_Controller's
			// /wp/v2/global-styles/themes/(?P<stylesheet>%s)) have no bare sibling
			// at all — the parameterised path is the *only* way to reach them. List
			// the base (e.g. "global-styles/themes") so it's still discoverable;
			// it's addressed the same way, via `get/update/delete <param>`.
			const route = basePath.slice( prefix.length );
			if ( ! route ) {
				continue;
			}
			results.push( { path, route } );
			continue;
		}

		results.push( { path, route: path.slice( prefix.length ) } );
	}
	return results;
}

const VERB_ORDER: Verb[] = [
	'list',
	'get',
	'create',
	'update',
	'delete',
	'exists',
	'generate',
];

/**
 * Which of the CLI's own verbs (not raw HTTP methods) a route supports,
 * inferred from the site index alone (no extra OPTIONS requests). `list` and
 * `create`/`generate` come from the collection path's own `methods`; `get`/
 * `exists`/`update`/`delete` operate on the *item* URL, whose methods live on
 * a separate index entry (`<route>/(?P<id>...)`) that `routesForNamespace`
 * deliberately hides from the route listing — this looks it back up. For a
 * route that only exists in parameterised form (see `routesForNamespace`),
 * `path` already *is* that item-level entry, so GET there maps to `get`/
 * `exists`, not `list`.
 * @param index The site's root REST API index.
 * @param path  The route's index path, as returned by {@link routesForNamespace}.
 * @return The CLI verbs this route supports, in the CLI's canonical order.
 */
export function supportedVerbsForRoute(
	index: IndexResponse,
	path: string
): Verb[] {
	// Only a *trailing* placeholder means `path` itself is the item-level entry
	// (see `routesForNamespace`) — a placeholder in the middle (e.g. a
	// per-parent sub-collection like `posts/(?P<parent>[\d]+)/autosaves`) is
	// still a GET-only collection, not a single addressable item.
	const isItemOnlyPath = stripTrailingPlaceholder( path ) !== path;
	const itemPath = isItemOnlyPath
		? path
		: Object.keys( index.routes ).find( ( candidate ) => {
				const stripped = stripTrailingPlaceholder( candidate );
				return stripped !== candidate && stripped === path;
		  } );

	const collectionMethods = new Set(
		isItemOnlyPath ? [] : index.routes[ path ]?.methods ?? []
	);
	const itemMethods = new Set(
		itemPath ? index.routes[ itemPath ]?.methods ?? [] : []
	);

	const supported = new Set< Verb >();
	if ( collectionMethods.has( 'GET' ) ) {
		supported.add( 'list' );
	}
	if ( itemMethods.has( 'GET' ) ) {
		supported.add( 'get' );
		supported.add( 'exists' );
	}
	if ( collectionMethods.has( 'POST' ) ) {
		supported.add( 'create' );
		supported.add( 'generate' );
	}
	if ( itemMethods.has( 'PUT' ) || itemMethods.has( 'PATCH' ) ) {
		supported.add( 'update' );
	}
	if ( itemMethods.has( 'DELETE' ) ) {
		supported.add( 'delete' );
	}

	return VERB_ORDER.filter( ( verb ) => supported.has( verb ) );
}

/**
 * Finds where a `route` string (e.g. "global-styles/themes", possibly built
 * from several CLI arguments) is registered. Distinguishes a normal
 * collection route from one that only exists in parameterised form (see
 * `routesForNamespace`), since the latter can't be introspected via a live
 * OPTIONS request on its bare path — the request won't match the route's
 * regex without a value in place of the parameter.
 * @param index     The site's root REST API index.
 * @param namespace The namespace the route lives under.
 * @param route     The CLI-addressed route name (the `<route>` argument, `/`-joined).
 * @return The route's real index path, and whether it needs an instantiated
 *         parameter value before it can be introspected.
 */
export function resolveRouteInfo(
	index: IndexResponse,
	namespace: string,
	route: string
): { path: string; requiresParam: boolean } {
	const exactPath = `/${ namespace }/${ route }`;
	if ( index.routes[ exactPath ] ) {
		return { path: exactPath, requiresParam: false };
	}
	for ( const path of Object.keys( index.routes ) ) {
		if ( ! path.includes( '(?P<' ) ) {
			continue;
		}
		const basePath = stripTrailingPlaceholder( path );
		if ( basePath !== path && basePath === exactPath ) {
			return { path, requiresParam: true };
		}
	}
	return { path: exactPath, requiresParam: false };
}

/**
 * Whether the site advertises support for WordPress core Application Passwords.
 * @param index The site's root REST API index.
 * @return Whether the `application-passwords` authentication entry is present.
 */
export function isApplicationPasswordsSupported(
	index: IndexResponse
): boolean {
	return Boolean(
		index.authentication?.[ 'application-passwords' ]?.endpoints
			?.authorization
	);
}
