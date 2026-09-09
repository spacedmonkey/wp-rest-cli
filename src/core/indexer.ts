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
 * Splits a path into its top-level `/`-separated segments, the way
 * WordPress's own route matching treats it — a `/` is only a separator when
 * it's outside any `(...)` group. Real route regexes routinely embed a
 * literal `/` (or even nested parens) *inside* a URL parameter's own
 * character class — e.g. WordPress core registers a stylesheet placeholder
 * as `(?P<stylesheet>[^\/:<>\*\?"\|]+(?:\/[^\/:<>\*\?"\|]+)?)` (to allow a
 * child theme's "parent/child" form) and an id placeholder as
 * `(?P<id>[\/\d+]+)`. Naively splitting on every `/` character (ignoring
 * that some of them sit inside such a group) would shred a placeholder like
 * that into unrelated fragments instead of treating it as the one segment
 * it actually is.
 * @param path A `/`-joined path to split.
 * @return `path`'s top-level segments.
 */
function splitPathSegments( path: string ): string[] {
	const segments: string[] = [];
	let current = '';
	let depth = 0;
	for ( const char of path ) {
		if ( char === '(' ) {
			depth++;
		} else if ( char === ')' ) {
			depth--;
		}
		if ( char === '/' && depth === 0 ) {
			segments.push( current );
			current = '';
		} else {
			current += char;
		}
	}
	segments.push( current );
	return segments;
}

/**
 * Whether an already-isolated path segment (see `splitPathSegments`) is
 * entirely a `(?P<name>...)` URL parameter placeholder, however complex its
 * inner pattern is.
 * @param segment One top-level segment of a route path.
 * @return Whether `segment` is a placeholder.
 */
function isPlaceholderSegment( segment: string ): boolean {
	return /^\(\?P<[^>]+>/.test( segment ) && segment.endsWith( ')' );
}

/**
 * Extracts a placeholder segment's captured name, e.g. `"stylesheet"` from
 * `(?P<stylesheet>...)`. Assumes `segment` already satisfies
 * `isPlaceholderSegment`.
 * @param segment A placeholder path segment.
 * @return The placeholder's name.
 */
function placeholderName( segment: string ): string {
	return (
		/^\(\?P<([^>]+)>/.exec( segment ) as RegExpExecArray
	 )[ 1 ] as string;
}

/**
 * One `(?P<name>...)` URL parameter found by `splitPlaceholders`.
 */
export interface PlaceholderParam {
	/** Where this value belongs among the route's literal segments (see `splitPlaceholders`). */
	index: number;
	/** The placeholder's captured name, e.g. "parent". */
	name: string;
}

/**
 * Splits any `/`-joined path into its literal segments and every
 * `(?P<name>...)` URL parameter placeholder it contains, in the order they
 * appear — generalizing to any number of parameters (0, 1, or more), for
 * routes that need more than one value to address a specific item, e.g.
 * `posts/(?P<parent>[\d]+)/revisions/(?P<id>[\d]+)` (one specific revision
 * of one specific post) has literal segments `['posts', 'revisions']` with
 * params `[{index: 1, name: 'parent'}, {index: 2, name: 'id'}]` — "parent"
 * belongs between "posts" and "revisions", "id" after "revisions" (i.e.
 * once "parent" has already been spliced in ahead of it).
 * @param path A `/`-joined path to split.
 * @return The literal segments (placeholders removed) and each placeholder's
 *         position among them plus its captured name, in path order.
 */
export function splitPlaceholders( path: string ): {
	segments: string[];
	params: PlaceholderParam[];
} {
	const rawSegments = splitPathSegments( path );
	const segments: string[] = [];
	const params: PlaceholderParam[] = [];
	for ( const segment of rawSegments ) {
		if ( isPlaceholderSegment( segment ) ) {
			params.push( {
				index: segments.length,
				name: placeholderName( segment ),
			} );
		} else {
			segments.push( segment );
		}
	}
	return { segments, params };
}

/**
 * Splices parameter values into a route's literal segments at their
 * declared positions (see `splitPlaceholders`), building the segment list
 * for the real, instantiated URL.
 * @param segments The route's literal segments (placeholders already removed).
 * @param params   Each parameter's position and name, in path order.
 * @param values   The values to splice in, one per `params` entry, in the same order.
 * @return `segments` with each value inserted at its position, URI-encoded.
 */
export function spliceParams(
	segments: string[],
	params: PlaceholderParam[],
	values: string[]
): string[] {
	const result = [ ...segments ];
	params.forEach( ( param, i ) => {
		result.splice(
			param.index + i,
			0,
			encodeURIComponent( values[ i ] as string )
		);
	} );
	return result;
}

/**
 * Strips a trailing `/(?P<name>...)` URL parameter segment, if the path ends with one.
 * @param path A route path, as it appears in the index's `routes` map.
 * @return `path` with any trailing regex parameter segment removed.
 */
export function stripTrailingPlaceholder( path: string ): string {
	const parsed = splitPlaceholder( path );
	if ( parsed && parsed.paramIndex === parsed.segments.length ) {
		return parsed.segments.join( '/' );
	}
	return path;
}

/**
 * Splits any `/`-joined path (a full index path, or one already relative to
 * its namespace — leading segments like a namespace are just literal
 * segments as far as this is concerned) into its literal segments and, if it
 * has exactly one `(?P<name>...)` URL parameter placeholder — anywhere in
 * the path, not just trailing — the position that parameter belongs at
 * among those literal segments. E.g. `posts/(?P<parent>[\d]+)/revisions` has
 * literal segments `['posts', 'revisions']` with `paramIndex: 1` (the id
 * belongs between them); a trailing placeholder like
 * `global-styles/themes/(?P<stylesheet>%s)` yields `paramIndex` equal to
 * `segments.length`, matching the CLI's existing "append the id at the end"
 * behaviour. A path with more than one placeholder returns `null` — routes
 * needing two or more parameters are handled separately, by
 * `resolveMultiParamRoute`, since this CLI's ordinary verb grammar takes
 * only one `<id>`.
 * @param path A `/`-joined path to split.
 * @return The literal segments, the placeholder's position and captured
 *         name (both `null` if there isn't one), or `null` if there's more
 *         than one placeholder.
 */
export function splitPlaceholder( path: string ): {
	segments: string[];
	paramIndex: number | null;
	paramName: string | null;
} | null {
	const { segments, params } = splitPlaceholders( path );
	if ( params.length > 1 ) {
		return null;
	}
	if ( params.length === 0 ) {
		return { segments, paramIndex: null, paramName: null };
	}
	const [ param ] = params;
	return {
		segments,
		paramIndex: ( param as PlaceholderParam ).index,
		paramName: ( param as PlaceholderParam ).name,
	};
}

/**
 * Finds a registered route with two or more URL parameters whose literal
 * segments, followed by exactly that many trailing tokens, match
 * `typedSegments` in full — e.g. typing `['posts', 'revisions', '5', '12']`
 * against a route registered as
 * `.../posts/(?P<parent>[\d]+)/revisions/(?P<id>[\d]+)` matches, with route
 * `"posts/revisions"` and the trailing `['5', '12']` as the values for
 * "parent" then "id", in that order. Zero- or one-parameter routes are
 * handled by `resolveRouteInfo` instead — this is specifically for the
 * two-or-more case, which is otherwise entirely unaddressable (every verb
 * here otherwise takes only one `<id>`).
 * @param index         The site's root REST API index.
 * @param namespace     The namespace to search.
 * @param typedSegments The full route as typed, already split on `/`.
 * @return The matched route (its index path, literal route name, and
 *         parameters) and the values typed for it, or `null` if no
 *         multi-parameter route matches.
 */
export function resolveMultiParamRoute(
	index: IndexResponse,
	namespace: string,
	typedSegments: string[]
): {
	path: string;
	route: string;
	params: PlaceholderParam[];
	values: string[];
} | null {
	const prefix = `/${ namespace }/`;
	for ( const path of Object.keys( index.routes ) ) {
		if ( ! path.startsWith( prefix ) || ! path.includes( '(?P<' ) ) {
			continue;
		}
		const { segments, params } = splitPlaceholders(
			path.slice( prefix.length )
		);
		if ( params.length < 2 ) {
			continue;
		}
		if ( typedSegments.length !== segments.length + params.length ) {
			continue;
		}
		const candidateLiteral = typedSegments.slice( 0, segments.length );
		if ( candidateLiteral.join( '/' ) !== segments.join( '/' ) ) {
			continue;
		}
		return {
			path,
			route: segments.join( '/' ),
			params,
			values: typedSegments.slice( segments.length ),
		};
	}
	return null;
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
			const parsed = splitPlaceholder( path.slice( prefix.length ) );
			if ( ! parsed || parsed.paramIndex === null ) {
				// More than one placeholder (e.g. a specific revision, addressed
				// by parent post *and* revision id) isn't addressable by this
				// CLI's single-<id> grammar, so it's left off the listing.
				continue;
			}
			const route = parsed.segments.join( '/' );
			if ( ! route ) {
				continue;
			}
			// Typical WP pattern: a bare collection (e.g. /posts) plus a singular
			// variant ending in a parameter (e.g. /posts/(?P<id>[\d]+)) — the latter
			// is reached via `get <id>` / `update <id>` / `delete <id>` on the bare
			// route, not addressed directly, so skip it here.
			if ( paths.includes( prefix + route ) ) {
				continue;
			}
			// Some routes have no bare sibling at all — either a trailing
			// parameter with no bare collection (e.g.
			// WP_REST_Global_Styles_Controller's
			// /wp/v2/global-styles/themes/(?P<stylesheet>%s)), or a parameter in
			// the *middle* of the path (e.g. /wp/v2/posts/(?P<parent>[\d]+)/revisions).
			// The parameterised path is the only way to reach them either way —
			// list the literal segments joined together (e.g. "global-styles/themes"
			// or "posts/revisions") so it's still discoverable; it's addressed the
			// same way, via `get/exists <param>`.
			results.push( { path, route } );
			continue;
		}

		results.push( { path, route: path.slice( prefix.length ) } );
	}
	return results;
}

/**
 * One next-level path segment beneath a route prefix, for directory-listing-
 * style navigation.
 */
export interface RouteChildSegment {
	/** The next literal path segment relative to the given prefix, e.g. "themes". */
	segment: string;
	/** The full namespace-relative route so far, e.g. "global-styles/themes". */
	route: string;
	/** Whether routes exist strictly deeper than `route`. */
	hasChildren: boolean;
	/**
	 * True for the synthetic "meta" pseudo-child callers may append when a
	 * route's schema declares a `meta` field — meta commands are a CLI-only
	 * concept layered on top of the REST resource, not a route this index
	 * knows about, so `route`/`hasChildren` don't resolve against it the way
	 * they do for a real child.
	 */
	isMeta?: boolean;
}

/**
 * Groups a namespace's leaf routes (from `routesForNamespace`) by their next
 * path segment beneath `routePrefix`, so a route can be explored one segment
 * at a time regardless of how many `/`-segments it's actually registered
 * with. Purely a topology/grouping layer — it doesn't resolve or validate
 * individual routes; callers still use `resolveRouteInfo` and
 * `supportedVerbsForRoute` for each child's own verbs, so a route that's
 * *also* directly addressable at the same prefix as a deeper sibling (a
 * "hybrid" case) is still discovered that way — this function only reports
 * what's available to recurse into.
 * @param index       The site's root REST API index.
 * @param namespace   The namespace the route lives under.
 * @param routePrefix The CLI-addressed route prefix to list children of (`''` for the namespace root).
 * @return One entry per distinct next segment beneath `routePrefix`.
 */
export function routeChildren(
	index: IndexResponse,
	namespace: string,
	routePrefix: string
): RouteChildSegment[] {
	const leafRoutes = routesForNamespace( index, namespace ).map(
		( r ) => r.route
	);
	const prefixDepth = routePrefix ? routePrefix.split( '/' ).length : 0;
	const children = new Map< string, RouteChildSegment >();
	for ( const leafRoute of leafRoutes ) {
		if (
			routePrefix &&
			leafRoute !== routePrefix &&
			! leafRoute.startsWith( `${ routePrefix }/` )
		) {
			continue;
		}
		const parts = leafRoute.split( '/' );
		if ( parts.length <= prefixDepth ) {
			continue; // leafRoute IS routePrefix itself, not a child level.
		}
		const route = parts.slice( 0, prefixDepth + 1 ).join( '/' );
		const existing = children.get( route );
		children.set( route, {
			segment: parts[ prefixDepth ] as string,
			route,
			hasChildren:
				existing?.hasChildren || parts.length > prefixDepth + 1,
		} );
	}
	return [ ...children.values() ];
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
 * Separately, a route registered with exactly one URL parameter *anywhere*
 * in its path (not just trailing — e.g. `posts/(?P<parent>[\d]+)/revisions`)
 * needs a value to be addressed at all, regardless of whether WordPress
 * itself considers its response a list or a single item; the CLI's existing
 * `get`/`exists <value>` grammar is how that value is supplied, so both are
 * always added for such a route in addition to whatever collection verbs it
 * already has.
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
	if ( collectionMethods.has( 'GET' ) ) {
		const placeholderInfo = splitPlaceholder( path );
		if ( placeholderInfo && placeholderInfo.paramIndex !== null ) {
			supported.add( 'get' );
			supported.add( 'exists' );
		}
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
 * @return The route's real index path, whether it needs an instantiated
 *         parameter value before it can be introspected, and (when it does)
 *         the position within `route.split('/')` that value belongs at and
 *         the parameter's declared name (e.g. "stylesheet", "parent").
 */
export function resolveRouteInfo(
	index: IndexResponse,
	namespace: string,
	route: string
): {
	path: string;
	requiresParam: boolean;
	paramIndex?: number;
	paramName?: string;
} {
	const exactPath = `/${ namespace }/${ route }`;
	if ( index.routes[ exactPath ] ) {
		return { path: exactPath, requiresParam: false };
	}
	const prefix = `/${ namespace }/`;
	for ( const path of Object.keys( index.routes ) ) {
		if ( ! path.startsWith( prefix ) || ! path.includes( '(?P<' ) ) {
			continue;
		}
		const parsed = splitPlaceholder( path.slice( prefix.length ) );
		if ( ! parsed || parsed.paramIndex === null ) {
			continue;
		}
		if ( parsed.segments.join( '/' ) === route ) {
			return {
				path,
				requiresParam: true,
				paramIndex: parsed.paramIndex,
				paramName: parsed.paramName ?? undefined,
			};
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
