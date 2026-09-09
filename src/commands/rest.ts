/**
 * Internal dependencies
 */
import { BasicAuthProvider } from '../core/auth/basic.js';
import { WpRestClient } from '../core/client.js';
import { resolveApiRoot } from '../core/discovery.js';
import { CliError, WpApiError } from '../core/errors.js';
import { formatOutput } from '../core/formatter.js';
import {
	fetchIndex,
	routeChildren,
	resolveRouteInfo,
	resolveMultiParamRoute,
	spliceParams,
	supportedVerbsForRoute,
	isApplicationPasswordsSupported,
	type RouteChildSegment,
} from '../core/indexer.js';
import { introspectRoute, supportedContexts } from '../core/introspect.js';
import { validateFieldTypes } from '../core/validate.js';
import { buildVerbRequest } from '../core/verbs.js';
import type {
	GlobalFlags,
	IndexResponse,
	RouteEndpoint,
	RouteSchema,
	Verb,
} from '../types.js';
import { withSpinner, pc } from '../ui.js';
import {
	META_VERBS,
	parseMetaArgs,
	runMetaCommand,
	printMetaUsage,
	printMetaVerbHelp,
	routeSupportsMeta,
	type MetaVerb,
	type ParsedMeta,
} from './meta.js';

const VERBS: Verb[] = [
	'list',
	'get',
	'create',
	'update',
	'delete',
	'exists',
	'generate',
];
const META_KEYWORD = 'meta';

export type ParsedCommand =
	| { mode: 'namespaces' }
	| { mode: 'routes'; namespace: string }
	| { mode: 'introspect'; namespace: string; route: string }
	| { mode: 'meta-usage'; namespace: string; route: string }
	| { mode: 'meta'; namespace: string; route: string; meta: ParsedMeta }
	| {
			mode: 'verb';
			namespace: string;
			route: string;
			verb: Verb;
			id?: string;
			fields: Record< string, string >;
	  };

/**
 * Whether a CLI token is a `field=value` pair rather than a positional argument.
 * @param token The raw token.
 * @return Whether `token` contains `=`.
 */
function isFieldToken( token: string ): boolean {
	return token.includes( '=' );
}

/**
 * Parses a run of `field=value` tokens (as used by `list`/`create`/`generate`).
 * @param tokens The tokens to parse.
 * @return The parsed field map.
 */
function parseFields( tokens: string[] ): Record< string, string > {
	const fields: Record< string, string > = {};
	for ( const token of tokens ) {
		const eq = token.indexOf( '=' );
		if ( eq === -1 ) {
			throw new CliError(
				`Expected a field=value argument, got "${ token }".`
			);
		}
		fields[ token.slice( 0, eq ) ] = token.slice( eq + 1 );
	}
	return fields;
}

/**
 * Consumes leading tokens as route segments (joined with "/") up to — but not
 * including — the first token that's a recognised verb. This lets a route
 * that WordPress itself nests under several literal path segments (e.g.
 * WP_REST_Global_Styles_Controller's `global-styles/themes/(?P<stylesheet>%s)`)
 * be addressed the same way WP-CLI addresses nested commands — as separate
 * words — rather than requiring one pre-joined "global-styles/themes" token:
 *   wp-rest-cli wp/v2 global-styles themes get <stylesheet>
 * A token that reaches this loop can't yet be distinguished from a genuine
 * (if unusual) route segment, so an unrecognised verb is no longer rejected
 * up front here — it's folded into the route and left to fail naturally
 * against the live API (see the introspect/verb handling below).
 * @param tokens The tokens following the namespace.
 * @return The `/`-joined route and the remaining, unconsumed tokens.
 */
function consumeRouteSegments( tokens: string[] ): {
	route: string;
	rest: string[];
} {
	const segments: string[] = [];
	let index = 0;
	while ( index < tokens.length ) {
		const token = tokens[ index ] as string;
		if (
			VERBS.includes( token as Verb ) ||
			token === META_KEYWORD ||
			isFieldToken( token )
		) {
			break;
		}
		segments.push( token );
		index++;
	}
	return { route: segments.join( '/' ), rest: tokens.slice( index ) };
}

/**
 * Parses the CLI's positional arguments into a typed {@link ParsedCommand},
 * dispatching on how many of `<namespace> <route> <verb> <id>` are present.
 * @param args The CLI's positional arguments (after `config`/`help` are ruled out).
 * @return The parsed command.
 */
export function parseCommandArgs( args: string[] ): ParsedCommand {
	const [ namespace, ...tail ] = args;
	if ( ! namespace ) {
		return { mode: 'namespaces' };
	}

	const { route, rest } = consumeRouteSegments( tail );
	if ( ! route ) {
		return { mode: 'routes', namespace };
	}

	const [ verbToken, ...verbRest ] = rest;
	if ( ! verbToken ) {
		return { mode: 'introspect', namespace, route };
	}
	if ( verbToken === META_KEYWORD ) {
		const [ metaVerbToken, ...metaRest ] = verbRest;
		if ( ! metaVerbToken ) {
			return { mode: 'meta-usage', namespace, route };
		}
		return {
			mode: 'meta',
			namespace,
			route,
			meta: parseMetaArgs( metaVerbToken, metaRest ),
		};
	}
	if ( isFieldToken( verbToken ) ) {
		throw new CliError(
			`Expected a verb (${ VERBS.join( ', ' ) }) before "${ verbToken }".`
		);
	}
	const verb = verbToken as Verb;

	if (
		verb === 'get' ||
		verb === 'update' ||
		verb === 'delete' ||
		verb === 'exists'
	) {
		const [ id, ...fieldTokens ] = verbRest;
		if ( ! id || isFieldToken( id ) ) {
			throw new CliError(
				`"${ verb }" requires an <id> as its first argument.`
			);
		}
		return {
			mode: 'verb',
			namespace,
			route,
			verb,
			id,
			fields: parseFields( fieldTokens ),
		};
	}

	return {
		mode: 'verb',
		namespace,
		route,
		verb,
		fields: parseFields( verbRest ),
	};
}

export type ParsedHelp =
	| { mode: 'namespace'; namespace: string }
	| { mode: 'route'; namespace: string; route: string }
	| { mode: 'verb'; namespace: string; route: string; verb: Verb }
	| { mode: 'meta-usage'; namespace: string; route: string }
	| {
			mode: 'meta-verb';
			namespace: string;
			route: string;
			metaVerb: MetaVerb;
	  };

/**
 * Which help renderer `runHelpCommand` should use: `'usage'` is the existing
 * dense, schema-driven `usage: ... \n   or: ...` block (`wp help ...` and bare
 * introspection); `'wpcli'` is the NAME/DESCRIPTION/SYNOPSIS/SUBCOMMANDS or
 * NAME/DESCRIPTION/SYNOPSIS/OPTIONS/EXAMPLES page real WP-CLI prints for
 * `--help`, used only when a command is run with a trailing `--help` flag.
 */
export type HelpStyle = 'usage' | 'wpcli';

/**
 * Parses `wp help [<namespace> [<route...> [<verb>]]]`'s arguments into a
 * typed {@link ParsedHelp}, mirroring {@link parseCommandArgs}'s shapes but
 * never expecting an `<id>` or `field=value` pairs, since help never performs
 * a request.
 * @param args The CLI's positional arguments after `help`.
 * @return The parsed help request.
 */
export function parseHelpArgs( args: string[] ): ParsedHelp {
	const [ namespace, ...tail ] = args;
	if ( ! namespace ) {
		throw new CliError(
			'Usage: wp-rest-cli help [<namespace> [<route...> [<verb>]]]'
		);
	}

	const { route, rest } = consumeRouteSegments( tail );
	if ( ! route ) {
		return { mode: 'namespace', namespace };
	}

	const [ verbToken ] = rest;
	if ( ! verbToken ) {
		return { mode: 'route', namespace, route };
	}
	if ( verbToken === META_KEYWORD ) {
		const [ metaVerbToken ] = rest.slice( 1 );
		if ( ! metaVerbToken ) {
			return { mode: 'meta-usage', namespace, route };
		}
		if ( ! META_VERBS.includes( metaVerbToken as MetaVerb ) ) {
			throw new CliError(
				`Unknown meta command "${ metaVerbToken }". Expected one of: ${ META_VERBS.join(
					', '
				) }.`
			);
		}
		return {
			mode: 'meta-verb',
			namespace,
			route,
			metaVerb: metaVerbToken as MetaVerb,
		};
	}
	if ( isFieldToken( verbToken ) ) {
		throw new CliError(
			`Expected a verb (${ VERBS.join( ', ' ) }) before "${ verbToken }".`
		);
	}
	return { mode: 'verb', namespace, route, verb: verbToken as Verb };
}

/**
 * Builds a Basic Auth provider from `--username`/`--password` flags, falling
 * back to `WP_USERNAME`/`WP_PASSWORD` env vars.
 * @param flags Global CLI flags.
 * @return An auth provider, or undefined if no credentials were given.
 */
function buildAuth( flags: GlobalFlags ): BasicAuthProvider | undefined {
	const username = flags.username ?? process.env.WP_USERNAME;
	const password = flags.password ?? process.env.WP_PASSWORD;
	if ( ! username || ! password ) {
		return undefined;
	}
	return new BasicAuthProvider( username, password );
}

/**
 * Parses `--content`'s raw value as JSON, for use as a create/update request body.
 * @param raw The raw `--content` flag value.
 * @return The parsed JSON value, or undefined if `--content` wasn't given.
 */
function resolveContent( raw: string | undefined ): unknown {
	if ( raw === undefined ) {
		return undefined;
	}
	if ( raw.startsWith( '@' ) ) {
		throw new CliError(
			'Reading --content from a file (@path) is not supported in this environment; pass inline JSON instead.'
		);
	}
	try {
		return JSON.parse( raw );
	} catch {
		throw new CliError( `--content must be valid JSON: ${ raw }` );
	}
}

/**
 * Renders one endpoint's arguments as detailed, one-per-line descriptions
 * (type, required/optional, enum, default) for the introspection view.
 * @param endpoint     The endpoint whose args to render.
 * @param urlParamName The name of this route's own URL parameter (e.g.
 *                     "stylesheet"), if it has one — WordPress commonly
 *                     declares it `required: false` in the schema itself,
 *                     since it's filled from the URL match rather than
 *                     validated as caller input, but it's never actually
 *                     optional: without it there's no valid URL to
 *                     request at all. This forces its display to
 *                     "required" regardless of what the schema says.
 * @return One formatted line per argument.
 */
function formatEndpointArgs(
	endpoint: RouteEndpoint,
	urlParamName?: string
): string[] {
	const args = endpoint.args ?? {};
	const names = Object.keys( args );
	if ( names.length === 0 ) {
		return [ '    (no arguments)' ];
	}
	const lines: string[] = [];
	for ( const name of names ) {
		const arg = args[ name ];
		if ( ! arg ) {
			continue;
		}
		const required =
			arg.required || name === urlParamName
				? pc.red( 'required' )
				: 'optional';
		const type = Array.isArray( arg.type )
			? arg.type.join( '|' )
			: arg.type ?? 'any';
		const enumSuffix = arg.enum ? ` enum(${ arg.enum.join( ',' ) })` : '';
		const defaultSuffix =
			arg.default !== undefined
				? ` default(${ JSON.stringify( arg.default ) })`
				: '';
		const urlParamSuffix =
			name === urlParamName ? ' (this route’s own URL parameter)' : '';
		lines.push(
			`    --${ name }=<${ type }>${ enumSuffix }${ defaultSuffix } [${ required }]${ urlParamSuffix }` +
				( arg.description ? ` — ${ arg.description }` : '' )
		);
	}
	return lines;
}

/**
 * Renders `wp <namespace> <route>`'s full introspection output: one section
 * per HTTP method, each with its detailed argument listing.
 * @param namespace    The route's namespace.
 * @param route        The route name.
 * @param endpoints    The route's introspected endpoints.
 * @param urlParamName The name of this route's own URL parameter, if it has one (see `formatEndpointArgs`).
 * @return The rendered introspection block.
 */
function printIntrospection(
	namespace: string,
	route: string,
	endpoints: RouteEndpoint[],
	urlParamName?: string
): string {
	const lines: string[] = [ pc.bold( `${ namespace }/${ route }` ) ];
	for ( const endpoint of endpoints ) {
		lines.push( '' );
		lines.push( pc.cyan( `  ${ endpoint.methods.join( ', ' ) }` ) );
		lines.push( ...formatEndpointArgs( endpoint, urlParamName ) );
	}
	return lines.join( '\n' );
}

// 'list' and 'create' map directly onto this route's *collection* endpoint
// (GET/POST on <namespace>/<route>), so their real argument schema is
// available from introspecting that URL. 'update' (PUT on the item URL
// <namespace>/<route>/<id>) has no schema of its own here — WordPress
// controllers generally accept the same writable fields for update as for
// create, so it borrows the create (POST) schema as the closest available
// approximation; 'generate' (which just calls create repeatedly) borrows it
// for the same reason. 'get', 'delete' and 'exists' have no useful schema to
// show either way.
const COLLECTION_VERB_METHOD: Partial< Record< Verb, string > > = {
	list: 'GET',
	create: 'POST',
	update: 'POST',
	generate: 'POST',
};

/**
 * Renders an endpoint's args WP-CLI-synopsis-style: `[--name=<name>]`, or
 * bare `--name=<name>` if required — including when `name` is the route's
 * own URL parameter (see `formatEndpointArgs`), which the schema itself
 * commonly (and misleadingly) marks optional.
 * @param args         The endpoint's argument schema.
 * @param urlParamName The name of this route's own URL parameter, if it has one.
 * @return The space-joined inline synopsis fragment.
 */
function formatArgsInline(
	args: RouteEndpoint[ 'args' ],
	urlParamName?: string
): string {
	if ( ! args ) {
		return '';
	}
	return Object.keys( args )
		.map( ( name ) =>
			args[ name ]?.required || name === urlParamName
				? `--${ name }=<${ name }>`
				: `[--${ name }=<${ name }>]`
		)
		.join( ' ' );
}

/**
 * Renders a route name the way it's actually typed at the CLI — as separate
 * words (`posts revisions`), not the internal `/`-joined form
 * (`posts/revisions`) used everywhere else to identify it — for use only in
 * literal example command lines meant to be copy-pasted and run.
 * @param route The route name.
 * @return `route` with every `/` replaced by a space.
 */
function displayRoute( route: string ): string {
	return route.replace( /\//g, ' ' );
}

/**
 * A single WP-CLI-style synopsis line for one verb, e.g. `wp-rest-cli wp/v2 posts create [--title=<title>] [--<field>=<value>]`.
 * @param namespace    The route's namespace.
 * @param route        The route name.
 * @param verb         The verb to build a synopsis for.
 * @param endpoints    The route's introspected endpoints.
 * @param urlParamName The name of this route's own URL parameter, if it has one.
 * @return The one-line synopsis.
 */
function buildVerbSynopsis(
	namespace: string,
	route: string,
	verb: Verb,
	endpoints: RouteEndpoint[],
	urlParamName?: string
): string {
	const base = `wp-rest-cli ${ namespace } ${ displayRoute(
		route
	) } ${ verb }`;
	const method = COLLECTION_VERB_METHOD[ verb ];
	const endpoint = method
		? endpoints.find( ( e ) => e.methods.includes( method ) )
		: undefined;
	const inlineArgs = formatArgsInline( endpoint?.args, urlParamName );
	const idPlaceholder = `<${ urlParamName ?? 'id' }>`;

	switch ( verb ) {
		case 'list':
			return [ base, inlineArgs ].filter( Boolean ).join( ' ' );
		case 'get':
			return `${ base } ${ idPlaceholder } [--context=<context>]`;
		case 'create':
			return [ base, inlineArgs, '[--<field>=<value>]' ]
				.filter( Boolean )
				.join( ' ' );
		case 'update':
			return [
				`${ base } ${ idPlaceholder }`,
				inlineArgs,
				'[--<field>=<value>]',
			]
				.filter( Boolean )
				.join( ' ' );
		case 'delete':
			return `${ base } ${ idPlaceholder } [--force]`;
		case 'exists':
			return `${ base } ${ idPlaceholder }`;
		case 'generate':
			return [
				base,
				'[--count=<count>]',
				inlineArgs,
				'[--<field>=<value>]',
			]
				.filter( Boolean )
				.join( ' ' );
	}
}

/**
 * A `usage: ... \n   or: ... ` block, matching `wp help <command>`'s synopsis
 * style — one line per verb this route actually supports (`supportedVerbs`,
 * from `supportedVerbsForRoute`). Filtering matters: a singleton resource
 * like `wp/v2/settings` has no addressable `<id>` at all, so unconditionally
 * offering `get <id>`/`update <id>`/`delete <id>`/`exists <id>` would send
 * users straight into a 404 that has nothing to do with a missing item.
 * @param namespace      The route's namespace.
 * @param route          The route name.
 * @param endpoints      The route's introspected endpoints.
 * @param supportedVerbs The verbs this route actually supports.
 * @param urlParamName   The name of this route's own URL parameter, if it has one.
 * @return The rendered `usage: ... \n   or: ...` block.
 */
function printRouteUsage(
	namespace: string,
	route: string,
	endpoints: RouteEndpoint[],
	supportedVerbs: Verb[],
	urlParamName?: string
): string {
	return VERBS.filter( ( verb ) => supportedVerbs.includes( verb ) )
		.map(
			( verb, i ) =>
				( i === 0 ? 'usage: ' : '   or: ' ) +
				buildVerbSynopsis(
					namespace,
					route,
					verb,
					endpoints,
					urlParamName
				)
		)
		.join( '\n' );
}

/**
 * Renders the child segments beneath a route prefix (or the namespace root)
 * as the same `{route, verbs}` table shape a leaf route listing already
 * uses, so drilling into a namespace feels the same at every level. A
 * container-only child (no verbs of its own — nothing is registered at
 * exactly this prefix, only deeper) gets a `(subcommand)` marker appended to
 * its verbs column; a "hybrid" child that's both directly addressable *and*
 * has further children shows both its real verbs and the marker.
 * @param index     The site's root REST API index.
 * @param namespace The namespace the children belong to.
 * @param children  The child segments to render, from `routeChildren`.
 * @param flags     Global CLI flags (format/fields/field/color).
 * @return The rendered listing, in the requested `--format`.
 */
async function renderRouteChildren(
	index: IndexResponse,
	namespace: string,
	children: RouteChildSegment[],
	flags: GlobalFlags
): Promise< string > {
	const rows = children.map( ( child ) => {
		if ( child.isMeta ) {
			return { route: child.segment, verbs: '(subcommand)' };
		}
		const info = resolveRouteInfo( index, namespace, child.route );
		const verbList = supportedVerbsForRoute( index, info.path );
		const parts = child.hasChildren
			? [ ...verbList, '(subcommand)' ]
			: verbList;
		return { route: child.segment, verbs: parts.join( ', ' ) };
	} );
	return formatOutput( rows, {
		format: flags.format,
		fields: flags.fields,
		field: flags.field,
		color: flags.color,
	} );
}

/**
 * Whether `route` is itself a real, addressable route — as opposed to a pure
 * container that only exists because deeper routes are registered beneath
 * it (e.g. "global-styles" has no route of its own, only the "themes" child
 * beneath it). A "hybrid" route (both real *and* having children, like
 * "global-styles/themes" once a "variations" child is registered beneath
 * it) counts as real here — `routeChildren`'s presence check alone can't
 * distinguish a hybrid from a pure container, since both have children.
 * @param index     The site's root REST API index.
 * @param namespace The route's namespace.
 * @param route     The route name.
 * @return Whether `route` resolves to an actual registered route.
 */
function isRealRoute(
	index: IndexResponse,
	namespace: string,
	route: string
): boolean {
	const info = resolveRouteInfo( index, namespace, route );
	return info.requiresParam || Boolean( index.routes[ info.path ] );
}

/**
 * Appends a synthetic "meta" child to `children` when the route's schema
 * declares a `meta` field, so `meta` shows up as a discoverable sub-route
 * alongside any real ones — it isn't a route the site's index knows about
 * (it's a CLI-only concept layered on top of the REST resource), but it's
 * navigable the same way (`wp <namespace> <route> meta ...`), so it belongs
 * in the same listing.
 * @param children  The route's real child segments, from `routeChildren`.
 * @param route     The route name, to build the synthetic child's `route` field.
 * @param endpoints The route's introspected endpoints.
 * @return `children`, with a trailing "meta" entry appended if the route supports it.
 */
function withMetaChild(
	children: RouteChildSegment[],
	route: string,
	endpoints: RouteEndpoint[]
): RouteChildSegment[] {
	if ( ! routeSupportsMeta( endpoints ) ) {
		return children;
	}
	return [
		...children,
		{
			segment: 'meta',
			route: `${ route }/meta`,
			hasChildren: false,
			isMeta: true,
		},
	];
}

/**
 * A dim note appended after a real route's own introspection output when it
 * also has nested child segments (the "hybrid" case) — otherwise the
 * children would be silently unreachable, since typing the route in full
 * lands on its own schema, not a child listing.
 * @param index     The site's root REST API index.
 * @param namespace The route's namespace.
 * @param children  The route's child segments, from `routeChildren`.
 * @param flags     Global CLI flags (format/fields/field/color).
 * @return The rendered note, or an empty string if there are no children.
 */
async function renderChildrenNote(
	index: IndexResponse,
	namespace: string,
	children: RouteChildSegment[],
	flags: GlobalFlags
): Promise< string > {
	if ( ! children.length ) {
		return '';
	}
	const childList = await renderRouteChildren(
		index,
		namespace,
		children,
		flags
	);
	return pc.dim( '\nThis route also has nested sub-routes:\n' ) + childList;
}

/**
 * Renders `wp help <namespace> <route> <verb>`'s single-verb help block: its
 * usage line, a warning if the route doesn't actually support it, its argument
 * schema, and any verb-specific notes (e.g. `--force` for delete).
 * @param namespace      The route's namespace.
 * @param route          The route name.
 * @param verb           The verb to describe.
 * @param endpoints      The route's introspected endpoints.
 * @param supportedVerbs The verbs this route actually supports.
 * @param urlParamName   The name of this route's own URL parameter, if it has one (see `formatEndpointArgs`).
 * @return The rendered help block.
 */
function printVerbHelp(
	namespace: string,
	route: string,
	verb: Verb,
	endpoints: RouteEndpoint[],
	supportedVerbs: Verb[],
	urlParamName?: string
): string {
	const lines: string[] = [
		pc.bold( `${ namespace }/${ route } ${ verb }` ),
		'',
		`  usage: ${ buildVerbSynopsis(
			namespace,
			route,
			verb,
			endpoints,
			urlParamName
		) }`,
	];

	if ( ! supportedVerbs.includes( verb ) ) {
		lines.push(
			'',
			pc.red(
				`  Warning: ${ namespace }/${ route } doesn't appear to support "${ verb }" — its registered ` +
					`methods are: ${
						supportedVerbs.length
							? supportedVerbs.join( ', ' )
							: '(none detected)'
					}.`
			)
		);
	}

	const method = COLLECTION_VERB_METHOD[ verb ];
	const endpoint = method
		? endpoints.find( ( e ) => e.methods.includes( method ) )
		: undefined;
	if ( endpoint ) {
		let label = `  ${ method } ${ namespace }/${ route } accepts:`;
		if ( verb === 'update' ) {
			label = `  ${ method } ${ namespace }/${ route } accepts (same writable fields as create):`;
		} else if ( verb === 'generate' ) {
			label = `  ${ method } ${ namespace }/${ route } accepts (same writable fields as create, applied to each item):`;
		}
		lines.push( '', pc.cyan( label ) );
		lines.push( ...formatEndpointArgs( endpoint, urlParamName ) );
	} else {
		lines.push(
			'',
			pc.dim(
				`  This operates on a single item (${ namespace }/${ route }/<${
					urlParamName ?? 'id'
				}>); its argument schema ` +
					`isn't exposed by the collection endpoint's OPTIONS response, but field=value pairs ` +
					`(if any) are still sent through as query parameters.`
			)
		);
	}
	if ( verb === 'delete' ) {
		lines.push(
			'',
			pc.dim(
				'  Pass --force to bypass trash and permanently delete, where supported.'
			)
		);
	}
	if ( verb === 'exists' ) {
		lines.push(
			'',
			pc.dim(
				'  Exits 0 if a GET for <id> succeeds, 1 if it 404s; prints nothing else in table format.'
			)
		);
	}
	if ( verb === 'generate' ) {
		lines.push(
			'',
			pc.dim(
				'  Pass --count=<n> to create that many items (default 1); the same fields are reused for every one.'
			)
		);
	}
	return lines.join( '\n' );
}

/**
 * Fetches a route's schema for introspection/help. A route that only exists
 * in parameterised form (see `resolveRouteInfo`) can't be reached with a live
 * OPTIONS request on its bare path — that path never matches the route's
 * regex without a value in place of the parameter — so its schema is read
 * from the already-fetched site index instead.
 * @param client      The REST client to issue requests with.
 * @param apiRoot     The resolved REST API root URL.
 * @param namespace   The route's namespace.
 * @param route       The route name.
 * @param showSpinner Whether to show progress spinners for the underlying requests.
 * @param index       An already-fetched site index to reuse, if the caller has one on hand.
 * @return The route's schema, whether it required a parameter (and, when it
 *         does, that parameter's declared name), and its supported verbs.
 */
async function getRouteSchema(
	client: WpRestClient,
	apiRoot: string,
	namespace: string,
	route: string,
	showSpinner: boolean,
	index?: IndexResponse
): Promise< {
	schema: RouteSchema;
	requiresParam: boolean;
	paramName?: string;
	verbs: Verb[];
} > {
	const resolvedIndex =
		index ??
		( await withSpinner( 'Fetching API index', showSpinner, () =>
			fetchIndex( client, apiRoot )
		) );
	const info = resolveRouteInfo( resolvedIndex, namespace, route );
	const verbs = supportedVerbsForRoute( resolvedIndex, info.path );
	if ( info.requiresParam ) {
		// info.path came from resolveRouteInfo enumerating index.routes' own keys.
		return {
			schema: resolvedIndex.routes[ info.path ] as RouteSchema,
			requiresParam: true,
			paramName: info.paramName,
			verbs,
		};
	}
	const routeUrl = new URL( `${ namespace }/${ route }`, apiRoot ).toString();
	const schema = await withSpinner(
		`Introspecting ${ namespace }/${ route }`,
		showSpinner,
		() => introspectRoute( client, routeUrl )
	);
	return { schema, requiresParam: false, verbs };
}

/**
 * Looks up where a route's URL parameter belongs (see `resolveRouteInfo`),
 * for verbs that are about to splice an `<id>` into the route. Requires a
 * fresh index fetch — unlike `getRouteSchema`, there's no schema to cache
 * here, just the position — so it's only called where an id is actually
 * present.
 * @param client      The REST client to issue the underlying index request with.
 * @param apiRoot     The resolved REST API root URL.
 * @param namespace   The route's namespace.
 * @param route       The route name.
 * @param showSpinner Whether to show a progress spinner for the index request.
 * @return The position within `route.split('/')` the id belongs at, or `undefined` for the default (append at the end).
 */
async function resolveParamIndex(
	client: WpRestClient,
	apiRoot: string,
	namespace: string,
	route: string,
	showSpinner: boolean
): Promise< number | undefined > {
	const index = await withSpinner( 'Fetching API index', showSpinner, () =>
		fetchIndex( client, apiRoot )
	);
	return resolveRouteInfo( index, namespace, route ).paramIndex;
}

/**
 * Validates a verb's `field=value` arguments against the route's live schema
 * for the matching HTTP method (see `COLLECTION_VERB_METHOD`), catching
 * type mismatches (e.g. `--per_page=abc` for an `integer` arg), and — for
 * every verb except `update` — any `required` arg missing from `fields`
 * altogether, locally before the request is ever sent. A no-op for verbs
 * with no entry in `COLLECTION_VERB_METHOD` (get/delete/exists), which have
 * no reliable arg schema to check against.
 * @param client      The REST client to issue the underlying schema request with.
 * @param apiRoot     The resolved REST API root URL.
 * @param namespace   The route's namespace.
 * @param route       The route name.
 * @param verb        The verb being run.
 * @param fields      The parsed `field=value` arguments to validate.
 * @param showSpinner Whether to show a progress spinner for the schema request.
 */
async function validateVerbFields(
	client: WpRestClient,
	apiRoot: string,
	namespace: string,
	route: string,
	verb: Verb,
	fields: Record< string, string >,
	showSpinner: boolean
): Promise< void > {
	const method = COLLECTION_VERB_METHOD[ verb ];
	if ( ! method ) {
		return;
	}
	const { schema } = await getRouteSchema(
		client,
		apiRoot,
		namespace,
		route,
		showSpinner
	);
	const endpoint = ( schema.endpoints ?? [] ).find( ( e ) =>
		e.methods.includes( method )
	);
	// Every verb here maps onto that verb's *own* live schema except
	// 'update', which borrows 'create'/POST's schema (WordPress exposes no
	// separate schema for the item-level PUT endpoint) — a partial update
	// legitimately omits create-time required fields, so only 'update' is
	// exempt from the required check.
	const checkRequired = verb !== 'update';
	validateFieldTypes( fields, endpoint?.args, checkRequired );
}

/**
 * Combines the WP-CLI-style usage synopsis with the existing detailed per-method arg listing.
 * @param namespace     The route's namespace.
 * @param route         The route name.
 * @param schema        The route's introspected schema.
 * @param requiresParam Whether the route only exists in parameterised form.
 * @param verbs         The verbs this route actually supports.
 * @param paramName     The name of this route's own URL parameter, if it requires one (see `formatEndpointArgs`).
 * @return The full rendered route help block.
 */
function renderRouteHelp(
	namespace: string,
	route: string,
	schema: RouteSchema,
	requiresParam: boolean,
	verbs: Verb[],
	paramName?: string
): string {
	const endpoints = schema.endpoints ?? [];
	const contexts = supportedContexts( schema );
	const metaUsage = routeSupportsMeta( endpoints )
		? '\n\n' + printMetaUsage( namespace, route )
		: '';
	const paramNote = requiresParam
		? pc.dim(
				`\nThis route only exists with a value in place of its URL parameter, e.g.:\n` +
					`  wp-rest-cli ${ namespace } ${ displayRoute(
						route
					) } get <${ paramName ?? 'value' }>\n`
		  )
		: '';
	const noIdNote =
		! requiresParam &&
		! verbs.some( ( v ) => v === 'get' || v === 'update' || v === 'delete' )
			? pc.dim(
					`\nThis route has no addressable <id> (it's a single/settings-style resource) — ` +
						`read and write it directly via 'list'/'create' on ${ namespace }/${ route }.\n`
			  )
			: '';
	const contextNote = contexts.length
		? pc.dim( `\nSupported --context values: ${ contexts.join( ', ' ) }\n` )
		: '';
	return (
		printRouteUsage( namespace, route, endpoints, verbs, paramName ) +
		metaUsage +
		paramNote +
		noIdNote +
		contextNote +
		'\n\n' +
		printIntrospection( namespace, route, endpoints, paramName )
	);
}

/**
 * A short, generic one-line description of what each verb does to a route,
 * parameterised by the route name — the closest available approximation of
 * WP-CLI's own hardcoded per-subcommand descriptions (e.g. `wp post create`'s
 * "Creates a new post."), since this CLI's routes aren't known ahead of time.
 */
const VERB_DESCRIPTIONS: Record< Verb, ( route: string ) => string > = {
	list: ( route ) => `Gets a list of ${ route }.`,
	get: ( route ) => `Gets details about a ${ route } item.`,
	create: ( route ) => `Creates a new ${ route } item.`,
	update: ( route ) => `Updates one or more existing ${ route } items.`,
	delete: ( route ) => `Deletes an existing ${ route } item.`,
	exists: ( route ) => `Verifies whether a ${ route } item exists.`,
	generate: ( route ) => `Generates some ${ route } items.`,
};

/** Verb-specific notes shown beneath OPTIONS/SUBCOMMANDS in the `--help` page. */
const VERB_NOTES: Partial< Record< Verb, string > > = {
	delete: 'Pass --force to bypass trash and permanently delete, where supported.',
	exists: 'Exits 0 if a GET for <id> succeeds, 1 if it 404s; prints nothing else in table format.',
	generate:
		'Pass --count=<n> to create that many items (default 1); the same fields are reused for every one.',
};

/**
 * Renders one endpoint's arguments WP-CLI `--help`-style: `[--name=<name>]`
 * (or bare `--name=<name>` if required), its description indented beneath,
 * and a `---` default/enum block when the schema declares them — matching
 * the shape of WP-CLI's own OPTIONS listings.
 * @param endpoint The endpoint whose args to render.
 * @return One or more formatted lines per argument.
 */
function formatOptionsWpCli( endpoint: RouteEndpoint ): string[] {
	const args = endpoint.args ?? {};
	const names = Object.keys( args );
	if ( names.length === 0 ) {
		return [ '  (no arguments)' ];
	}
	const lines: string[] = [];
	for ( const name of names ) {
		const arg = args[ name ];
		if ( ! arg ) {
			continue;
		}
		lines.push(
			`  ${
				arg.required
					? `--${ name }=<${ name }>`
					: `[--${ name }=<${ name }>]`
			}`
		);
		if ( arg.description ) {
			lines.push( `      ${ arg.description }` );
		}
		if ( arg.enum || arg.default !== undefined ) {
			lines.push( '      ---' );
			if ( arg.default !== undefined ) {
				lines.push(
					`      default: ${ JSON.stringify( arg.default ) }`
				);
			}
			if ( arg.enum ) {
				lines.push( '      options:' );
				lines.push(
					...arg.enum.map( ( value ) => `        - ${ value }` )
				);
			}
			lines.push( '      ---' );
		}
		lines.push( '' );
	}
	if ( lines[ lines.length - 1 ] === '' ) {
		lines.pop();
	}
	return lines;
}

/**
 * A single realistic-looking example invocation for a verb, e.g.
 * `wp-rest-cli wp/v2 widgets create --title=<title> --url=https://example.com`
 * — unlike {@link buildVerbSynopsis}, this only includes an endpoint's
 * *required* args (no `[--optional=<optional>]` bracket noise), since it's
 * meant to read as a command a user could actually type.
 * @param namespace The route's namespace.
 * @param route     The route name.
 * @param verb      The verb to build an example for.
 * @param endpoint  The matching HTTP method's endpoint schema, if any.
 * @return The example command line, without its leading `$ `.
 */
function buildExampleInvocation(
	namespace: string,
	route: string,
	verb: Verb,
	endpoint: RouteEndpoint | undefined
): string {
	const base = `wp-rest-cli ${ namespace } ${ route } ${ verb }`;
	const id =
		verb === 'get' ||
		verb === 'update' ||
		verb === 'delete' ||
		verb === 'exists'
			? ' <id>'
			: '';
	const requiredArgs = Object.entries( endpoint?.args ?? {} )
		.filter( ( [ , arg ] ) => arg?.required )
		.map( ( [ name ] ) => `--${ name }=<${ name }>` )
		.join( ' ' );
	return [ base + id, requiredArgs, '--url=https://example.com' ]
		.filter( Boolean )
		.join( ' ' );
}

/**
 * Renders `<namespace> <route> --help`'s WP-CLI-native help page — NAME,
 * DESCRIPTION, SYNOPSIS, SUBCOMMANDS and EXAMPLES — mirroring the format real
 * WP-CLI prints for a resource command like `wp post --help`. This is a
 * separate, friendlier rendering from {@link renderRouteHelp}'s denser
 * `usage:`/`or:` block, which `wp help ...` and bare introspection keep using.
 * @param namespace      The route's namespace.
 * @param route          The route name.
 * @param schema         The route's introspected schema.
 * @param requiresParam  Whether the route only exists in parameterised form.
 * @param supportedVerbs The verbs this route actually supports.
 * @return The rendered help page.
 */
function renderRouteHelpWpCli(
	namespace: string,
	route: string,
	schema: RouteSchema,
	requiresParam: boolean,
	supportedVerbs: Verb[]
): string {
	const endpoints = schema.endpoints ?? [];
	const hasMeta = routeSupportsMeta( endpoints );
	const commands = VERBS.filter( ( verb ) =>
		supportedVerbs.includes( verb )
	);
	const subcommandNames: string[] = [
		...commands,
		...( hasMeta ? [ META_KEYWORD ] : [] ),
	];
	const width =
		Math.max( ...subcommandNames.map( ( name ) => name.length ) ) + 4;

	const descriptionLines = [
		`  Manage the "${ route }" resource under ${ namespace }.`,
	];
	if ( requiresParam ) {
		descriptionLines.push(
			'',
			'  This route only exists with a value in place of its URL parameter, e.g.:',
			`    wp-rest-cli ${ namespace } ${ route } get <value>`
		);
	}
	if (
		! requiresParam &&
		! commands.some(
			( verb ) => verb === 'get' || verb === 'update' || verb === 'delete'
		)
	) {
		descriptionLines.push(
			'',
			"  This resource has no addressable <id> — read and write it directly via 'list'/'create'."
		);
	}
	const contexts = supportedContexts( schema );
	if ( contexts.length ) {
		descriptionLines.push(
			'',
			`  Supported --context values: ${ contexts.join( ', ' ) }`
		);
	}

	const subcommandLines = [
		...commands.map(
			( verb ) =>
				`  ${ verb.padEnd( width ) }${ VERB_DESCRIPTIONS[ verb ](
					route
				) }`
		),
		...( hasMeta
			? [
					`  ${ META_KEYWORD.padEnd(
						width
					) }Adds, updates, deletes, and lists ${ route } custom fields.`,
			  ]
			: [] ),
	];

	const exampleVerbs: Verb[] = [
		'list',
		'get',
		'create',
		'update',
		'delete',
	];
	const exampleLines = exampleVerbs
		.filter( ( verb ) => commands.includes( verb ) )
		.map( ( verb ) => {
			const method = COLLECTION_VERB_METHOD[ verb ];
			const endpoint = method
				? endpoints.find( ( e ) => e.methods.includes( method ) )
				: undefined;
			return (
				`    # ${ VERB_DESCRIPTIONS[ verb ]( route ) }\n` +
				`    $ ${ buildExampleInvocation(
					namespace,
					route,
					verb,
					endpoint
				) }`
			);
		} );

	return [
		pc.bold( 'NAME' ),
		'',
		`  wp-rest-cli ${ namespace } ${ route }`,
		'',
		pc.bold( 'DESCRIPTION' ),
		'',
		...descriptionLines,
		'',
		pc.bold( 'SYNOPSIS' ),
		'',
		`  wp-rest-cli ${ namespace } ${ route } <command>`,
		'',
		pc.bold( 'SUBCOMMANDS' ),
		'',
		...subcommandLines,
		'',
		pc.bold( 'EXAMPLES' ),
		'',
		exampleLines.join( '\n\n' ),
	].join( '\n' );
}

/**
 * Renders `<namespace> <route> <verb> --help`'s WP-CLI-native help page —
 * NAME, DESCRIPTION, SYNOPSIS, OPTIONS (when the verb has a live arg schema)
 * and EXAMPLES — mirroring the format real WP-CLI prints for a leaf command
 * like `wp post create --help`. A separate, friendlier rendering from
 * {@link printVerbHelp}, which `wp help ...` keeps using.
 * @param namespace      The route's namespace.
 * @param route          The route name.
 * @param verb           The verb to describe.
 * @param endpoints      The route's introspected endpoints.
 * @param supportedVerbs The verbs this route actually supports.
 * @return The rendered help page.
 */
function renderVerbHelpWpCli(
	namespace: string,
	route: string,
	verb: Verb,
	endpoints: RouteEndpoint[],
	supportedVerbs: Verb[]
): string {
	const lines: string[] = [
		pc.bold( 'NAME' ),
		'',
		`  wp-rest-cli ${ namespace } ${ route } ${ verb }`,
		'',
		pc.bold( 'DESCRIPTION' ),
		'',
		`  ${ VERB_DESCRIPTIONS[ verb ]( route ) }`,
	];

	if ( ! supportedVerbs.includes( verb ) ) {
		lines.push(
			'',
			pc.red(
				`  Warning: ${ namespace }/${ route } doesn't appear to support "${ verb }" — its registered ` +
					`methods are: ${
						supportedVerbs.length
							? supportedVerbs.join( ', ' )
							: '(none detected)'
					}.`
			)
		);
	}

	lines.push(
		'',
		pc.bold( 'SYNOPSIS' ),
		'',
		`  ${ buildVerbSynopsis( namespace, route, verb, endpoints ) }`
	);

	const method = COLLECTION_VERB_METHOD[ verb ];
	const endpoint = method
		? endpoints.find( ( e ) => e.methods.includes( method ) )
		: undefined;
	if ( endpoint ) {
		lines.push(
			'',
			pc.bold( 'OPTIONS' ),
			'',
			...formatOptionsWpCli( endpoint )
		);
	}

	if ( VERB_NOTES[ verb ] ) {
		lines.push( '', pc.dim( `  ${ VERB_NOTES[ verb ] }` ) );
	}

	lines.push(
		'',
		pc.bold( 'EXAMPLES' ),
		'',
		`    # ${ VERB_DESCRIPTIONS[ verb ]( route ) }`,
		`    $ ${ buildExampleInvocation( namespace, route, verb, endpoint ) }`
	);

	return lines.join( '\n' );
}

/**
 * Executes a parsed command against the REST API: discovers the API root,
 * then dispatches on `parsed.mode` to list namespaces/routes, introspect a
 * route, run a meta subcommand, or perform the request for a verb.
 * @param parsed  The parsed command.
 * @param flags   Global CLI flags.
 * @param siteUrl The bare site URL or hostname to run the command against.
 * @return The command's rendered output and exit code.
 */
export async function runRestCommand(
	parsed: ParsedCommand,
	flags: GlobalFlags,
	siteUrl: string
): Promise< { output: string; exitCode: number } > {
	const client = new WpRestClient( buildAuth( flags ), flags.debug );

	const apiRoot = await withSpinner(
		'Discovering REST API',
		! flags.quiet,
		() => resolveApiRoot( siteUrl, flags.debug )
	);

	if ( parsed.mode === 'namespaces' ) {
		const index = await withSpinner(
			'Fetching API index',
			! flags.quiet,
			() => fetchIndex( client, apiRoot )
		);
		const rows = index.namespaces.map( ( namespace ) => ( { namespace } ) );
		const output = await formatOutput( rows, {
			format: flags.format,
			fields: flags.fields,
			field: flags.field,
			color: flags.color,
		} );
		const note = isApplicationPasswordsSupported( index )
			? pc.dim( '\nApplication Passwords are supported on this site.' )
			: pc.dim(
					'\nApplication Passwords do not appear to be supported on this site.'
			  );
		return {
			output: output + ( flags.format === 'table' ? note : '' ),
			exitCode: 0,
		};
	}

	if ( parsed.mode === 'routes' ) {
		const index = await withSpinner(
			'Fetching API index',
			! flags.quiet,
			() => fetchIndex( client, apiRoot )
		);
		const children = routeChildren( index, parsed.namespace, '' );
		const output = await renderRouteChildren(
			index,
			parsed.namespace,
			children,
			flags
		);
		return { output, exitCode: 0 };
	}

	if ( parsed.mode === 'introspect' ) {
		const index = await withSpinner(
			'Fetching API index',
			! flags.quiet,
			() => fetchIndex( client, apiRoot )
		);
		const children = routeChildren( index, parsed.namespace, parsed.route );
		if (
			children.length > 0 &&
			! isRealRoute( index, parsed.namespace, parsed.route )
		) {
			const output = await renderRouteChildren(
				index,
				parsed.namespace,
				children,
				flags
			);
			return { output, exitCode: 0 };
		}
		const multiParamMatch = resolveMultiParamRoute(
			index,
			parsed.namespace,
			parsed.route.split( '/' )
		);
		if ( multiParamMatch ) {
			const instantiatedSegments = spliceParams(
				multiParamMatch.route.split( '/' ),
				multiParamMatch.params,
				multiParamMatch.values
			);
			const url = new URL(
				`${ parsed.namespace }/${ instantiatedSegments.join( '/' ) }`,
				apiRoot
			).toString();
			const { body } = await withSpinner(
				`GET ${ parsed.namespace }/${ displayRoute( parsed.route ) }`,
				! flags.quiet,
				() => client.request( url, { method: 'GET' } )
			);
			const output = await formatOutput( body, {
				format: flags.format,
				fields: flags.fields,
				field: flags.field,
				color: flags.color,
			} );
			return { output, exitCode: 0 };
		}
		const { schema, requiresParam, paramName, verbs } =
			await getRouteSchema(
				client,
				apiRoot,
				parsed.namespace,
				parsed.route,
				! flags.quiet,
				index
			);
		if ( flags.format !== 'table' ) {
			const output = await formatOutput( schema, {
				format: flags.format,
				fields: flags.fields,
				field: flags.field,
				color: flags.color,
			} );
			return { output, exitCode: 0 };
		}
		return {
			output:
				renderRouteHelp(
					parsed.namespace,
					parsed.route,
					schema,
					requiresParam,
					verbs,
					paramName
				) +
				( await renderChildrenNote(
					index,
					parsed.namespace,
					withMetaChild(
						children,
						parsed.route,
						schema.endpoints ?? []
					),
					flags
				) ),
			exitCode: 0,
		};
	}

	if ( parsed.mode === 'meta-usage' ) {
		return {
			output: printMetaUsage( parsed.namespace, parsed.route ),
			exitCode: 0,
		};
	}

	if ( parsed.mode === 'meta' ) {
		return runMetaCommand(
			parsed.meta,
			client,
			apiRoot,
			parsed.namespace,
			parsed.route,
			flags
		);
	}

	if ( parsed.verb === 'exists' ) {
		const paramIndex = await resolveParamIndex(
			client,
			apiRoot,
			parsed.namespace,
			parsed.route,
			! flags.quiet
		);
		const request = buildVerbRequest( {
			verb: 'exists',
			apiRoot,
			namespace: parsed.namespace,
			route: parsed.route,
			id: parsed.id,
			paramIndex,
			context: flags.context,
			fields: parsed.fields,
		} );
		let exists = true;
		try {
			await withSpinner(
				`GET ${ parsed.namespace }/${ parsed.route }`,
				! flags.quiet,
				() => client.request( request.url, { method: request.method } )
			);
		} catch ( error ) {
			if ( error instanceof WpApiError && error.status === 404 ) {
				exists = false;
			} else {
				throw error;
			}
		}
		if ( flags.format === 'table' && ! flags.field && ! flags.fields ) {
			return {
				output: exists
					? pc.green(
							`Success: ${ parsed.route } ${ parsed.id } exists.`
					  )
					: pc.dim(
							`${ parsed.route } ${ parsed.id } does not exist.`
					  ),
				exitCode: exists ? 0 : 1,
			};
		}
		const output = await formatOutput(
			{ exists },
			{
				format: flags.format,
				fields: flags.fields,
				field: flags.field,
				color: flags.color,
			}
		);
		return { output, exitCode: exists ? 0 : 1 };
	}

	if ( parsed.verb === 'generate' ) {
		const { count: countRaw, ...createFields } = parsed.fields;
		const count = countRaw !== undefined ? Number( countRaw ) : 1;
		if ( ! Number.isInteger( count ) || count < 1 ) {
			throw new CliError(
				`--count must be a positive integer, got "${ countRaw }".`
			);
		}
		await validateVerbFields(
			client,
			apiRoot,
			parsed.namespace,
			parsed.route,
			'generate',
			createFields,
			! flags.quiet
		);

		const created: unknown[] = [];
		for ( let i = 0; i < count; i++ ) {
			const request = buildVerbRequest( {
				verb: 'create',
				apiRoot,
				namespace: parsed.namespace,
				route: parsed.route,
				context: flags.context,
				fields: createFields,
				content: resolveContent( flags.content ),
			} );
			const { body } = await withSpinner(
				`POST ${ parsed.namespace }/${ parsed.route } (${
					i + 1
				}/${ count })`,
				! flags.quiet,
				() =>
					client.request( request.url, {
						method: request.method,
						body: request.body,
					} )
			);
			created.push( body );
		}
		if ( flags.format === 'table' && ! flags.field && ! flags.fields ) {
			const ids = created
				.map( ( r ) => ( r as { id?: unknown } | undefined )?.id ?? '' )
				.join( ' ' );
			return {
				output: pc.green(
					`Success: created ${ count } ${ parsed.route }: ${ ids }`.trim()
				),
				exitCode: 0,
			};
		}
		const output = await formatOutput( created, {
			format: flags.format,
			fields: flags.fields,
			field: flags.field,
			color: flags.color,
		} );
		return { output, exitCode: 0 };
	}

	// parsed.mode === 'verb', parsed.verb is now one of list/get/create/update/delete
	await validateVerbFields(
		client,
		apiRoot,
		parsed.namespace,
		parsed.route,
		parsed.verb,
		parsed.fields,
		! flags.quiet
	);
	const paramIndex = parsed.id
		? await resolveParamIndex(
				client,
				apiRoot,
				parsed.namespace,
				parsed.route,
				! flags.quiet
		  )
		: undefined;
	const request = buildVerbRequest( {
		verb: parsed.verb,
		apiRoot,
		namespace: parsed.namespace,
		route: parsed.route,
		id: parsed.id,
		paramIndex,
		context: flags.context,
		fields: parsed.fields,
		content: resolveContent( flags.content ),
	} );

	const { body } = await withSpinner(
		`${ request.method } ${ parsed.namespace }/${ parsed.route }`,
		! flags.quiet,
		() =>
			client.request( request.url, {
				method: request.method,
				body: request.body,
			} )
	);

	if (
		parsed.verb === 'create' ||
		parsed.verb === 'update' ||
		parsed.verb === 'delete'
	) {
		const record = body as { id?: number | string } | undefined;
		const verbLabel = {
			create: 'Created',
			update: 'Updated',
			delete: 'Deleted',
		}[ parsed.verb ];
		const idLabel = record?.id ?? parsed.id ?? '';
		if ( flags.format === 'table' && ! flags.field && ! flags.fields ) {
			return {
				output: pc.green(
					`Success: ${ verbLabel } ${ parsed.route } ${ idLabel }.`.trim()
				),
				exitCode: 0,
			};
		}
	}

	const output = await formatOutput( body, {
		format: flags.format,
		fields: flags.fields,
		field: flags.field,
		color: flags.color,
	} );
	return { output, exitCode: 0 };
}

/**
 * Read-only help lookups, mirroring `wp help <command>...`: shows routes for a
 * namespace, a route's full schema, or (given a verb) just that verb's calling
 * convention and matching argument schema — never performs the verb's request.
 * @param parsed  The parsed help request.
 * @param flags   Global CLI flags.
 * @param siteUrl The bare site URL or hostname to run the lookup against.
 * @param style   Which help page to render for `'route'`/`'verb'` modes —
 *                the existing dense `usage:` block, or the WP-CLI-native
 *                NAME/DESCRIPTION/SYNOPSIS page used for a trailing `--help`.
 * @return The rendered help output and exit code.
 */
export async function runHelpCommand(
	parsed: ParsedHelp,
	flags: GlobalFlags,
	siteUrl: string,
	style: HelpStyle = 'usage'
): Promise< { output: string; exitCode: number } > {
	const client = new WpRestClient( buildAuth( flags ), flags.debug );
	const apiRoot = await withSpinner(
		'Discovering REST API',
		! flags.quiet,
		() => resolveApiRoot( siteUrl, flags.debug )
	);

	if ( parsed.mode === 'namespace' ) {
		const index = await withSpinner(
			'Fetching API index',
			! flags.quiet,
			() => fetchIndex( client, apiRoot )
		);
		const children = routeChildren( index, parsed.namespace, '' );
		const output = await renderRouteChildren(
			index,
			parsed.namespace,
			children,
			flags
		);
		return { output, exitCode: 0 };
	}

	if ( parsed.mode === 'meta-usage' ) {
		return {
			output: printMetaUsage( parsed.namespace, parsed.route ),
			exitCode: 0,
		};
	}

	if ( parsed.mode === 'meta-verb' ) {
		return {
			output: printMetaVerbHelp(
				parsed.namespace,
				parsed.route,
				parsed.metaVerb
			),
			exitCode: 0,
		};
	}

	if ( parsed.mode === 'route' ) {
		const index = await withSpinner(
			'Fetching API index',
			! flags.quiet,
			() => fetchIndex( client, apiRoot )
		);
		const children = routeChildren( index, parsed.namespace, parsed.route );
		if (
			children.length > 0 &&
			! isRealRoute( index, parsed.namespace, parsed.route )
		) {
			const output = await renderRouteChildren(
				index,
				parsed.namespace,
				children,
				flags
			);
			return { output, exitCode: 0 };
		}
		const { schema, requiresParam, paramName, verbs } =
			await getRouteSchema(
				client,
				apiRoot,
				parsed.namespace,
				parsed.route,
				! flags.quiet,
				index
			);
		return {
			output:
				( style === 'wpcli'
					? renderRouteHelpWpCli(
							parsed.namespace,
							parsed.route,
							schema,
							requiresParam,
							verbs
					  )
					: renderRouteHelp(
							parsed.namespace,
							parsed.route,
							schema,
							requiresParam,
							verbs,
							paramName
					  ) ) +
				( await renderChildrenNote(
					index,
					parsed.namespace,
					withMetaChild(
						children,
						parsed.route,
						schema.endpoints ?? []
					),
					flags
				) ),
			exitCode: 0,
		};
	}

	// parsed.mode === 'verb'
	const { schema, paramName, verbs } = await getRouteSchema(
		client,
		apiRoot,
		parsed.namespace,
		parsed.route,
		! flags.quiet
	);
	return {
		output:
			style === 'wpcli'
				? renderVerbHelpWpCli(
						parsed.namespace,
						parsed.route,
						parsed.verb,
						schema.endpoints ?? [],
						verbs
				  )
				: printVerbHelp(
						parsed.namespace,
						parsed.route,
						parsed.verb,
						schema.endpoints ?? [],
						verbs,
						paramName
				  ),
		exitCode: 0,
	};
}
