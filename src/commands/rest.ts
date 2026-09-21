/**
 * WordPress dependencies
 */
/**
 * Internal dependencies
 */
import { getSiteCredential, normalizeSiteUrl } from '../config.js';
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
import { runUploadCommand } from './upload.js';
import { BasicAuthProvider } from '../core/auth/basic.js';
import { OAuth2AuthProvider } from '../core/auth/oauth2.js';
import type { AuthProvider } from '../core/auth/types.js';
import {
	APPLICATION_PASSWORDS_AUTH_TYPE,
	OAUTH2_AUTH_TYPE,
} from '../core/auth/types.js';
import { WpRestClient } from '../core/client.js';
import { resolveApiRoot } from '../core/discovery.js';
import { CliError, WpApiError } from '../core/errors.js';
import { followCreatedLocation } from '../core/follow-location.js';
import { formatOutput } from '../core/formatter.js';
import { generateDefaultValue } from '../core/generate-defaults.js';
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
import { planUploads } from '../core/upload.js';
import {
	coerceJsonFields,
	unknownFieldWarnings,
	validateFieldTypes,
} from '../core/validate.js';
import { buildVerbRequest, isKeyedRoute } from '../core/verbs.js';
import type {
	EndpointArgSchema,
	GlobalFlags,
	IndexResponse,
	RouteEndpoint,
	RouteSchema,
	Verb,
} from '../types.js';
import {
	agentMode,
	withSpinner,
	pc,
	notice,
	createProgressBar,
} from '../ui.js';

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
			/** Every value of a field given more than once (only file fields honor repeats). */
			repeated?: Record< string, string[] >;
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
 * Collects every value of each `field=value` key that appears more than once,
 * so a repeated file field (`--file=@a --file=@b`) isn't lost to last-one-wins.
 * @param tokens The tokens to scan.
 * @return The values per repeated key, or undefined when no key repeats.
 */
function collectRepeated(
	tokens: string[]
): Record< string, string[] > | undefined {
	const seen: Record< string, string[] > = {};
	for ( const token of tokens ) {
		const eq = token.indexOf( '=' );
		if ( eq > 0 ) {
			( seen[ token.slice( 0, eq ) ] ??= [] ).push(
				token.slice( eq + 1 )
			);
		}
	}
	const repeated = Object.fromEntries(
		Object.entries( seen ).filter( ( [ , values ] ) => values.length > 1 )
	);
	return Object.keys( repeated ).length > 0 ? repeated : undefined;
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
			repeated: collectRepeated( fieldTokens ),
		};
	}

	return {
		mode: 'verb',
		namespace,
		route,
		verb,
		fields: parseFields( verbRest ),
		repeated: collectRepeated( verbRest ),
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
 * Builds a `BasicAuthProvider` from a username/password pair that was
 * *explicitly* given together (both present, from the same source) — used
 * for `--username`/`--password` flags and for `WP_USERNAME`/`WP_PASSWORD` env
 * vars alike, so both sources reject the same "only one given" and "given but
 * empty" mistakes the same way. Checks presence (`!== undefined`) rather than
 * truthiness, so an explicitly-empty value is caught too — it's "given," just
 * given nothing — rather than being indistinguishable from not having been
 * passed at all.
 * @param  username    The username, if given.
 * @param  password    The password, if given.
 * @param  sourceLabel What to call this source in an error message (e.g.
 *                     `'--username and --password'` or `'WP_USERNAME and WP_PASSWORD'`).
 * @return The provider if both were given (and non-empty), or undefined if
 *         neither was given at all.
 * @throws {CliError} If exactly one of the pair was given, or both were given empty.
 */
function providerFromPair(
	username: string | undefined,
	password: string | undefined,
	sourceLabel: string
): BasicAuthProvider | undefined {
	const usernameGiven = username !== undefined;
	const passwordGiven = password !== undefined;
	if ( ! usernameGiven && ! passwordGiven ) {
		return undefined;
	}
	if ( usernameGiven !== passwordGiven ) {
		throw new CliError(
			`Both ${ sourceLabel } must be given together — only one was provided.`
		);
	}
	if ( ! username || ! password ) {
		throw new CliError( `${ sourceLabel } must not be empty.` );
	}
	return new BasicAuthProvider( username, password );
}

/**
 * Builds an auth provider, in this precedence order: `--username`/
 * `--password` flags, then `WP_USERNAME`/`WP_PASSWORD` env vars, then a
 * credential previously saved for `siteUrl` via `wp auth <type> login`/`wp
 * auth <type> add`. Application Passwords work over plain Basic Auth (see
 * `BasicAuthProvider`); OAuth2 credentials use a bearer token (see
 * `OAuth2AuthProvider`).
 *
 * Written as an explicit switch on `flags.useAuth` first — rather than a
 * single env-var gate with auth-type branches folded in around it — so that
 * adding a further `AuthSource` value later can't silently fall through into
 * the env-var/stored fallback below by mistake (a real bug this function
 * used to be one edit away from: widening only the auth-type branch without
 * also widening the env-var gate's own condition).
 *
 * `--use-auth=env`/`--use-auth=application-passwords`/`--use-auth=oauth2`
 * each pin resolution to exactly that one source (skipping the rest of the
 * chain below it), erroring if that source has nothing available rather than
 * silently falling through to the next one — an escape hatch for when, say,
 * `WP_USERNAME`/`WP_PASSWORD` are set in the shell for some unrelated purpose
 * and would otherwise silently shadow a stored `wp auth` credential on every
 * invocation, with no per-command indication that's happening. The
 * non-`env`/`none` values name a `wp auth` type (see `AuthSource`) rather
 * than a generic "stored", since a site can now store a credential of each
 * type at once — with neither `--use-auth` nor `--username`/`--password`/env
 * vars given, both types stored for the same site is an error (ambiguous)
 * rather than a silent preference for one. `--use-auth=none` skips both env
 * vars and any stored credential, forcing an anonymous request even if
 * either is available. An explicit `--username`/`--password` flag pair
 * always wins regardless of `--use-auth` — it's the most deliberate override
 * available.
 * @param flags   Global CLI flags.
 * @param siteUrl The site the request is being made against.
 * @return An auth provider, or undefined if no credentials are available.
 */
function buildAuth(
	flags: GlobalFlags,
	siteUrl: string
): AuthProvider | undefined {
	const fromFlags = providerFromPair(
		flags.username,
		flags.password,
		'--username and --password'
	);
	if ( fromFlags ) {
		return fromFlags;
	}

	if ( flags.useAuth === 'none' ) {
		return undefined;
	}

	if ( flags.useAuth === OAUTH2_AUTH_TYPE ) {
		const stored = getSiteCredential( siteUrl, OAUTH2_AUTH_TYPE );
		if ( ! stored ) {
			throw new CliError(
				`--use-auth=${ OAUTH2_AUTH_TYPE } was given, but no OAuth2 credential is stored for ${ normalizeSiteUrl(
					siteUrl
				) }. Store one first with "wp auth oauth2 login" or "wp auth oauth2 add".`
			);
		}
		return new OAuth2AuthProvider( stored.accessToken );
	}

	if ( flags.useAuth === APPLICATION_PASSWORDS_AUTH_TYPE ) {
		const stored = getSiteCredential(
			siteUrl,
			APPLICATION_PASSWORDS_AUTH_TYPE
		);
		if ( ! stored ) {
			throw new CliError(
				`--use-auth=${ APPLICATION_PASSWORDS_AUTH_TYPE } was given, but no credential is stored for ${ normalizeSiteUrl(
					siteUrl
				) }. Store one first with "wp auth application-passwords login" or "wp auth application-passwords add".`
			);
		}
		return new BasicAuthProvider( stored.username, stored.password );
	}

	// `flags.useAuth` is 'env' or undefined here — every other value returned
	// or threw above.
	const fromEnv = providerFromPair(
		process.env.WP_USERNAME,
		process.env.WP_PASSWORD,
		'WP_USERNAME and WP_PASSWORD'
	);
	if ( fromEnv ) {
		return fromEnv;
	}
	if ( flags.useAuth === 'env' ) {
		throw new CliError(
			'--use-auth=env was given, but WP_USERNAME/WP_PASSWORD are not set.'
		);
	}

	const storedAppPasswords = getSiteCredential(
		siteUrl,
		APPLICATION_PASSWORDS_AUTH_TYPE
	);
	const storedOAuth2 = getSiteCredential( siteUrl, OAUTH2_AUTH_TYPE );
	if ( storedAppPasswords && storedOAuth2 ) {
		throw new CliError(
			`Both an application-passwords and an oauth2 credential are stored for ${ normalizeSiteUrl(
				siteUrl
			) } — pass --use-auth=application-passwords or --use-auth=oauth2 to disambiguate.`
		);
	}
	if ( storedAppPasswords ) {
		return new BasicAuthProvider(
			storedAppPasswords.username,
			storedAppPasswords.password
		);
	}
	if ( storedOAuth2 ) {
		return new OAuth2AuthProvider( storedOAuth2.accessToken );
	}
	return undefined;
}

/**
 * Parses `--body`'s raw value as JSON, for use as a create/update request body.
 * @param raw The raw `--body` flag value.
 * @return The parsed JSON value, or undefined if `--body` wasn't given.
 */
function resolveBodyOverride( raw: string | undefined ): unknown {
	if ( raw === undefined ) {
		return undefined;
	}
	if ( raw.startsWith( '@' ) ) {
		throw new CliError(
			'Reading --body from a file (@path) is not supported in this environment; pass inline JSON instead.'
		);
	}
	try {
		return JSON.parse( raw );
	} catch {
		throw new CliError( `--body must be valid JSON: ${ raw }` );
	}
}

/**
 * Renders one endpoint's arguments for the introspection view, in real
 * WP-CLI's own `--help` OPTIONS style: `[--name=<type>]` (bare, no brackets,
 * if required), its description indented beneath, and a `---`-delimited
 * `default:`/`options:` block when the schema declares them — rather than
 * this project's own type/enum/default shorthand it used before, which
 * didn't match anything a WP-CLI user would recognise. `<type>` (not the arg
 * name, as real WP-CLI's own hardcoded synopses use) is the placeholder,
 * since — unlike a real WP-CLI command — this route's fields aren't known
 * ahead of time, so the type is the more useful thing to show.
 * @param endpoint     The endpoint whose args to render.
 * @param urlParamName The name of this route's own URL parameter (e.g.
 *                     "stylesheet"), if it has one — WordPress commonly
 *                     declares it `required: false` in the schema itself,
 *                     since it's filled from the URL match rather than
 *                     validated as caller input, but it's never actually
 *                     optional: without it there's no valid URL to
 *                     request at all. This forces its display to
 *                     required (bare, no brackets) regardless of what the
 *                     schema says.
 * @return The formatted lines, one block per argument (blank-line separated).
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
		const required = arg.required || name === urlParamName;
		const type = Array.isArray( arg.type )
			? arg.type.join( '|' )
			: arg.type ?? 'any';
		const header = required
			? `--${ name }=<${ type }>`
			: `[--${ name }=<${ type }>]`;
		const urlParamSuffix =
			name === urlParamName
				? pc.dim( ' (this route’s own URL parameter)' )
				: '';
		lines.push( `    ${ header }${ urlParamSuffix }` );
		if ( arg.description ) {
			lines.push( `        ${ arg.description }` );
		}
		if ( arg.enum || arg.default !== undefined ) {
			lines.push( '        ---' );
			if ( arg.default !== undefined ) {
				lines.push(
					`        default: ${ JSON.stringify( arg.default ) }`
				);
			}
			if ( arg.enum ) {
				lines.push( '        options:' );
				lines.push(
					...arg.enum.map( ( value ) => `          - ${ value }` )
				);
			}
			lines.push( '        ---' );
		}
		lines.push( '' );
	}
	if ( lines[ lines.length - 1 ] === '' ) {
		lines.pop();
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
 * Known WordPress core error codes for a hidden content requirement: a
 * field a route's own live schema declares `required: false` (so
 * `generate`'s normal required-field synthesis never touches it), yet a
 * plain-PHP check elsewhere in the controller still rejects the item over
 * it. Each entry lists the field(s) that error implies, in priority order
 * — `generate`'s create loop catches one of these codes, synthesizes
 * whichever of these fields the route's schema actually declares and the
 * user didn't already supply, and retries once. Deliberately narrow (a
 * fixed table of known codes, not "retry on any 400") so a genuinely
 * invalid request from the user still fails loudly instead of being
 * silently papered over.
 * - `empty_content` (posts/pages/CPTs, `WP_REST_Posts_Controller`):
 *   title/content/excerpt can't all be empty at once — any one of them
 *   fixes it, so all three (that the schema declares) are filled.
 * - `rest_comment_content_invalid` (`WP_REST_Comments_Controller`):
 *   content is unconditionally required, unlike the posts case above.
 */
const HIDDEN_REQUIRED_FIELDS_BY_ERROR_CODE: Record< string, string[] > = {
	empty_content: [ 'title', 'content', 'excerpt' ],
	rest_comment_content_invalid: [ 'content' ],
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
 * Builds the child segments beneath a route prefix (or the namespace root)
 * into the same `{route, verbs}` shape a leaf route listing already uses, so
 * drilling into a namespace feels the same at every level. A container-only
 * child (no verbs of its own — nothing is registered at exactly this prefix,
 * only deeper) gets a `(subcommand)` marker appended to its verbs column; a
 * "hybrid" child that's both directly addressable *and* has further children
 * shows both its real verbs and the marker.
 * @param index     The site's root REST API index.
 * @param namespace The namespace the children belong to.
 * @param children  The child segments to render, from `routeChildren`.
 * @return One `{route, verbs}` row per child.
 */
function buildChildRows(
	index: IndexResponse,
	namespace: string,
	children: RouteChildSegment[]
): { route: string; verbs: string }[] {
	return children.map( ( child ) => {
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
}

/**
 * Structured form of a route's child segments, for `--format=json` output:
 * `verbs` as a real array plus a `has_children` flag, instead of
 * {@link buildChildRows}' `"list, get, (subcommand)"` display string.
 * @param index     The site's root REST API index.
 * @param namespace The namespace the children belong to.
 * @param children  The child segments to describe (from `routeChildren`).
 * @return One `{route, verbs, has_children}` object per child.
 */
function buildChildObjects(
	index: IndexResponse,
	namespace: string,
	children: RouteChildSegment[]
): { route: string; verbs: string[]; has_children: boolean }[] {
	return children.map( ( child ) => {
		if ( child.isMeta ) {
			return { route: child.segment, verbs: [], has_children: true };
		}
		const info = resolveRouteInfo( index, namespace, child.route );
		return {
			route: child.segment,
			verbs: supportedVerbsForRoute( index, info.path ),
			has_children: child.hasChildren,
		};
	} );
}

/**
 * The structured (`--format=json`/`yaml`) description of a route: its verbs,
 * endpoints (each with a `required` list of arg names) and nested children.
 * Deliberately omits the item response `schema` an OPTIONS response also
 * carries — it is large and not needed to call the route.
 * @param index         The site's root REST API index.
 * @param namespace     The route's namespace.
 * @param route         The route name.
 * @param schema        The route's introspected schema.
 * @param requiresParam Whether the route only exists in parameterised form.
 * @param verbs         The verbs this route supports.
 * @param children      The route's child segments, from `routeChildren`.
 * @param paramName     The route's own URL parameter name, if any.
 * @return A plain object ready for `formatOutput`.
 */
function routeHelpObject(
	index: IndexResponse,
	namespace: string,
	route: string,
	schema: RouteSchema,
	requiresParam: boolean,
	verbs: Verb[],
	children: RouteChildSegment[],
	paramName?: string
): Record< string, unknown > {
	const endpoints = schema.endpoints ?? [];
	return {
		namespace,
		route,
		requiresParam,
		paramName,
		verbs,
		endpoints: withRequiredLists( endpoints ),
		children: buildChildObjects(
			index,
			namespace,
			withMetaChild( children, route, endpoints )
		),
	};
}

/**
 * Adds a `required` array (names of required args) to each endpoint.
 * @param endpoints The endpoints to annotate.
 * @return Copies of `endpoints`, each with a `required` list.
 */
function withRequiredLists( endpoints: RouteEndpoint[] ): RouteEndpoint[] {
	return endpoints.map( ( endpoint ) => ( {
		...endpoint,
		required: Object.entries( endpoint.args ?? {} )
			.filter( ( [ , arg ] ) => arg?.required )
			.map( ( [ name ] ) => name ),
	} ) );
}

/**
 * Renders a route's (or the namespace root's) child segments as a plain
 * `{route, verbs}` listing in the requested `--format` — the table form used
 * for a route's own nested-children note, and for any non-`table` format of
 * the top-level bare listing (see `renderChildListWpCli` for the WP-CLI-style
 * page `table` format uses there instead).
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
	const rows = agentMode()
		? buildChildObjects( index, namespace, children )
		: buildChildRows( index, namespace, children );
	return formatOutput( rows, {
		format: flags.format,
		fields: flags.fields,
		field: flags.field,
		color: flags.color,
	} );
}

/**
 * Renders a list of `{label, description}` items as WP-CLI's own SUBCOMMANDS
 * rows: each label padded out to the widest one in the list plus a fixed
 * gap, followed by its description — or the bare label alone when there's no
 * description to show (avoids trailing whitespace).
 * @param items The rows to render.
 * @return One formatted line per item.
 */
function formatSubcommandRows(
	items: { label: string; description: string }[]
): string[] {
	const width = Math.max( ...items.map( ( item ) => item.label.length ) ) + 4;
	return items.map( ( item ) =>
		item.description
			? `  ${ item.label.padEnd( width ) }${ item.description }`
			: `  ${ item.label }`
	);
}

/**
 * Renders a WP-CLI-native NAME/DESCRIPTION/SYNOPSIS/SUBCOMMANDS page for a
 * list of child items — namespaces under the bare CLI, or routes under a
 * namespace — mirroring the page real WP-CLI's own bare `wp` prints. Used
 * only for the top-level bare `wp-rest-cli` / `wp-rest-cli <namespace>`
 * listing in `--format=table`; other formats keep returning the raw
 * `{route, verbs}`-shaped rows (see `buildChildRows`/`renderRouteChildren`)
 * for scripting — this page is for the top-level listing alone (a route's
 * own nested-children note, `renderChildrenNote`, reuses just the
 * `formatSubcommandRows` row style above, without the NAME/DESCRIPTION/
 * SYNOPSIS headers, since it's appended to output that already has those).
 * @param name        The command name line, e.g. "wp-rest-cli" or "wp-rest-cli wp/v2".
 * @param description One or more description lines (empty string for a blank line).
 * @param synopsis    The one-line synopsis, e.g. "wp-rest-cli <namespace>".
 * @param items       Each subcommand's name and one-line description (may be empty).
 * @return The rendered page.
 */
function renderChildListWpCli(
	name: string,
	description: string[],
	synopsis: string,
	items: { label: string; description: string }[]
): string {
	return [
		pc.bold( 'NAME' ),
		'',
		`  ${ name }`,
		'',
		pc.bold( 'DESCRIPTION' ),
		'',
		...description.map( ( line ) => ( line ? `  ${ line }` : '' ) ),
		'',
		pc.bold( 'SYNOPSIS' ),
		'',
		`  ${ synopsis }`,
		'',
		pc.bold( 'SUBCOMMANDS' ),
		'',
		...formatSubcommandRows( items ),
	].join( '\n' );
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
 * lands on its own schema, not a child listing. Only used for `--format=table`
 * (see the call sites), so it always renders WP-CLI's own SUBCOMMANDS row
 * style (`formatSubcommandRows`) rather than the plain `{route, verbs}` table
 * `renderRouteChildren` still produces for other formats.
 * @param index     The site's root REST API index.
 * @param namespace The route's namespace.
 * @param children  The route's child segments, from `routeChildren`.
 * @return The rendered note, or an empty string if there are no children.
 */
function renderChildrenNote(
	index: IndexResponse,
	namespace: string,
	children: RouteChildSegment[]
): string {
	if ( ! children.length ) {
		return '';
	}
	const rows = buildChildRows( index, namespace, children );
	const lines = formatSubcommandRows(
		rows.map( ( row ) => ( { label: row.route, description: row.verbs } ) )
	);
	return (
		pc.dim( '\nThis route also has nested sub-routes:\n' ) +
		lines.join( '\n' )
	);
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
 * Throws a clear error when a namespace isn't registered on the site.
 * @param index     The site's root REST API index.
 * @param namespace The namespace to check.
 */
function assertNamespace( index: IndexResponse, namespace: string ): void {
	if ( ! index.namespaces.includes( namespace ) ) {
		throw new CliError(
			`No such namespace "${ namespace }". Available: ${ index.namespaces.join(
				', '
			) }.`
		);
	}
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
	assertNamespace( resolvedIndex, namespace );
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
 * Best-effort discovers a real widget type id for `wp/v2/widgets`' `id_base`
 * field — the one hidden-required-field case (see
 * `HIDDEN_REQUIRED_FIELDS_BY_ERROR_CODE`) that can't be synthesized from
 * nothing the way a title or username placeholder can: a widget type has
 * to actually be registered on the site, discoverable only via the sibling
 * `{namespace}/widget-types` collection, never the `widgets` route's own
 * schema. Returns undefined on any failure (network error, empty list,
 * unexpected shape) — a caller falls back to surfacing the original
 * `rest_invalid_widget` error rather than one about this lookup itself.
 * @param client    The REST client to issue the request with.
 * @param apiRoot   The resolved REST API root URL.
 * @param namespace The namespace `widgets` was addressed under (e.g. `wp/v2`).
 * @return The first available widget type's id, or undefined.
 */
async function resolveWidgetIdBase(
	client: WpRestClient,
	apiRoot: string,
	namespace: string
): Promise< string | undefined > {
	try {
		const url = new URL(
			`${ namespace }/widget-types`,
			apiRoot
		).toString();
		const { body } = await client.request< unknown >( url, {
			method: 'GET',
		} );
		const items = Array.isArray( body )
			? body
			: Object.values( ( body as Record< string, unknown > ) ?? {} );
		const first = items[ 0 ];
		const id =
			first && typeof first === 'object' && 'id' in first
				? ( first as { id: unknown } ).id
				: undefined;
		return typeof id === 'string' ? id : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Validates a verb's `field=value` arguments against the route's live schema
 * for the matching HTTP method (see `COLLECTION_VERB_METHOD`), catching
 * type mismatches (e.g. `--per_page=abc` for an `integer` arg), and — for
 * every verb except `update`, and unless a caller opts out via
 * `enforceRequired` — any `required` arg missing from `fields` altogether,
 * locally before the request is ever sent. A no-op for verbs with no entry
 * in `COLLECTION_VERB_METHOD` (get/delete/exists), which have no reliable
 * arg schema to check against.
 * @param client          The REST client to issue the underlying schema request with.
 * @param apiRoot         The resolved REST API root URL.
 * @param namespace       The route's namespace.
 * @param route           The route name.
 * @param verb            The verb being run.
 * @param fields          The parsed `field=value` arguments to validate.
 * @param showSpinner     Whether to show a progress spinner for the schema request.
 * @param enforceRequired Whether missing `required` args should still be
 *                        treated as a hard failure. Defaults to `true`;
 *                        `generate` alone passes `false`, since it
 *                        synthesizes a placeholder for a missing required
 *                        field instead of erroring — see `runRestCommand`'s
 *                        `generate` branch.
 * @return The matching endpoint's arg schema, if any — callers reuse it to
 *         JSON-coerce object/array-typed field values (`coerceJsonFields`)
 *         without a second schema request.
 */
async function validateVerbFields(
	client: WpRestClient,
	apiRoot: string,
	namespace: string,
	route: string,
	verb: Verb,
	fields: Record< string, string >,
	showSpinner: boolean,
	enforceRequired = true
): Promise< Record< string, EndpointArgSchema > | undefined > {
	const method = COLLECTION_VERB_METHOD[ verb ];
	if ( ! method ) {
		return undefined;
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
	// exempt from the required check. 'generate' opts out via
	// `enforceRequired` instead of this per-verb list, since it still wants
	// the required check for every OTHER purpose (e.g. informing which
	// fields need a synthesized value) — see the generate branch below.
	const checkRequired = verb !== 'update' && enforceRequired;
	validateFieldTypes( fields, endpoint?.args, checkRequired );
	// `update` borrows create's schema, so it would false-positive on
	// item-only args. Warnings ignore --quiet on purpose: they flag likely typos.
	if ( agentMode() && verb !== 'update' ) {
		for ( const warning of unknownFieldWarnings(
			fields,
			endpoint?.args
		) ) {
			notice( warning, true );
		}
	}
	return endpoint?.args;
}

/**
 * Combines the WP-CLI-style usage synopsis with the existing detailed
 * per-method arg listing. Doesn't say anything about `meta` itself even when
 * the route supports it (no `usage: ... meta add ...` dump) — the caller
 * already appends a nested-children note (`renderChildrenNote`, with `meta`
 * folded in via `withMetaChild`) right after this, which is where `meta`
 * shows up as a discoverable subcommand; repeating its full 8-line usage
 * block here as well was pure noise on every single route that supports it.
 * Run `wp <namespace> <route> meta` (or `wp help ... meta`) for that detail.
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
	const client = new WpRestClient( buildAuth( flags, siteUrl ), flags.debug );

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
		const note = isApplicationPasswordsSupported( index )
			? pc.dim( '\nApplication Passwords are supported on this site.' )
			: pc.dim(
					'\nApplication Passwords do not appear to be supported on this site.'
			  );
		if ( flags.format === 'table' ) {
			const output =
				renderChildListWpCli(
					'wp-rest-cli',
					[
						"Talk to any WordPress site's REST API, WP-CLI style.",
						'',
						"Run 'wp-rest-cli help <namespace>' to get more information on a specific namespace.",
					],
					'wp-rest-cli <namespace>',
					index.namespaces.map( ( namespace ) => ( {
						label: namespace,
						description: '',
					} ) )
				) + '\n';
			return { output: output + note, exitCode: 0 };
		}
		const rows = index.namespaces.map( ( namespace ) => ( { namespace } ) );
		const output = await formatOutput( rows, {
			format: flags.format,
			fields: flags.fields,
			field: flags.field,
			color: flags.color,
		} );
		return { output, exitCode: 0 };
	}

	if ( parsed.mode === 'routes' ) {
		const index = await withSpinner(
			'Fetching API index',
			! flags.quiet,
			() => fetchIndex( client, apiRoot )
		);
		assertNamespace( index, parsed.namespace );
		const children = routeChildren( index, parsed.namespace, '' );
		if ( flags.format === 'table' ) {
			const rows = buildChildRows( index, parsed.namespace, children );
			const output = renderChildListWpCli(
				`wp-rest-cli ${ parsed.namespace }`,
				[
					`Routes available under the "${ parsed.namespace }" namespace.`,
					'',
					`Run 'wp-rest-cli help ${ parsed.namespace } <route>' to get more information on a specific route.`,
				],
				`wp-rest-cli ${ parsed.namespace } <route>`,
				rows.map( ( row ) => ( {
					label: row.route,
					description: row.verbs,
				} ) )
			);
			return { output, exitCode: 0 };
		}
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
			if ( flags.format === 'table' ) {
				const rows = buildChildRows(
					index,
					parsed.namespace,
					children
				);
				const output = renderChildListWpCli(
					`wp-rest-cli ${ parsed.namespace } ${ displayRoute(
						parsed.route
					) }`,
					[
						`This route has no schema of its own — it's a pure container for the routes nested beneath it.`,
					],
					`wp-rest-cli ${ parsed.namespace } ${ displayRoute(
						parsed.route
					) } <route>`,
					rows.map( ( row ) => ( {
						label: row.route,
						description: row.verbs,
					} ) )
				);
				return { output, exitCode: 0 };
			}
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
		if ( ! isRealRoute( index, parsed.namespace, parsed.route ) ) {
			throw new CliError(
				`No such route "${ parsed.namespace }/${ displayRoute(
					parsed.route
				) }". Run "wp-rest-cli ${ parsed.namespace }" to list routes.`
			);
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
			// Agent mode: same compact, children-aware object as `help`, minus the
			// bulky item `schema`; everyone else keeps the raw OPTIONS response.
			const output = await formatOutput(
				agentMode()
					? routeHelpObject(
							index,
							parsed.namespace,
							parsed.route,
							schema,
							requiresParam,
							verbs,
							children,
							paramName
					  )
					: schema,
				{
					format: flags.format,
					fields: flags.fields,
					field: flags.field,
					color: flags.color,
				}
			);
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
				renderChildrenNote(
					index,
					parsed.namespace,
					withMetaChild(
						children,
						parsed.route,
						schema.endpoints ?? []
					)
				),
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
			responseFields: flags.fields,
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
		// Type-checks user-supplied fields but does NOT hard-fail on a missing
		// required field (`enforceRequired: false`) — generate synthesizes a
		// placeholder for each one instead, per item, below.
		const generateArgs = await validateVerbFields(
			client,
			apiRoot,
			parsed.namespace,
			parsed.route,
			'generate',
			createFields,
			! flags.quiet,
			false
		);

		const missingRequiredArgs = Object.entries( generateArgs ?? {} ).filter(
			( [ name, arg ] ) => arg?.required && ! ( name in createFields )
		);
		if ( missingRequiredArgs.length ) {
			notice(
				`Note: ${ missingRequiredArgs
					.map( ( [ name ] ) => `--${ name }` )
					.join( ', ' ) } not supplied; using generated values.`,
				! flags.quiet
			);
		}

		// Some WP core controllers reject an item over a field that's
		// declared `required: false` in the schema — so `missingRequiredArgs`
		// above never catches it — via a plain-PHP check elsewhere in the
		// controller instead. Detected from a live error matching
		// `HIDDEN_REQUIRED_FIELDS_BY_ERROR_CODE`; every field it implies that
		// the route's schema actually declares (and the user didn't already
		// supply) is added here — same treatment as any other field
		// `generate` decides needs a synthesized value — and reused for
		// every subsequent item, so only the one item that triggers it
		// needs a retry — the rest are pre-filled from the start.
		const hiddenRequiredFallbackArgs: Array<
			[ string, EndpointArgSchema ]
		> = [];

		// A handful of fields (so far, just `wp/v2/widgets`' `id_base`) can't
		// be synthesized at all — they need a real value discovered from a
		// live request, not a placeholder — so they're resolved once, kept
		// fixed (not re-derived per index like `generateDefaultValue`'s
		// output), and reused for the rest of the batch. See
		// `resolveWidgetIdBase`.
		const fixedFallbackFields: Record< string, string > = {};

		/**
		 * Builds this item's request fields: user-supplied fields, any
		 * discovered fixed-value fallback fields, plus a freshly synthesized
		 * value (unique to `index`) for every field `generate` has decided
		 * needs one so far.
		 * @param index The 1-based position of the item being generated.
		 * @return The merged `field=value` map for this item.
		 */
		function buildGenerateFields(
			index: number
		): Record< string, string > {
			const rawFields: Record< string, string > = {
				...createFields,
				...fixedFallbackFields,
			};
			for ( const [ name, arg ] of [
				...missingRequiredArgs,
				...hiddenRequiredFallbackArgs,
			] ) {
				rawFields[ name ] = generateDefaultValue( name, arg, index );
			}
			return rawFields;
		}

		const generateNamespace = parsed.namespace;
		const generateRoute = parsed.route;

		/**
		 * Sends this item's create request, built from `fields`.
		 * @param index  The 1-based position of the item being generated.
		 * @param fields This item's `field=value` map.
		 * @return The created item's response body.
		 */
		async function sendGenerateRequest(
			index: number,
			fields: Record< string, string >
		): Promise< unknown > {
			const request = buildVerbRequest( {
				verb: 'create',
				apiRoot,
				namespace: generateNamespace,
				route: generateRoute,
				context: flags.context,
				fields: coerceJsonFields( fields, generateArgs ),
				bodyOverride: resolveBodyOverride( flags.body ),
				responseFields: flags.fields,
			} );
			const response = await client.request( request.url, {
				method: request.method,
				body: request.body,
			} );
			const followed = await followCreatedLocation(
				client,
				apiRoot,
				response,
				flags
			);
			return followed ? followed.body : response.body;
		}

		// Progress bar takes over from here — no more per-item spinner text,
		// it just ticks once for every item actually created.
		const progress = createProgressBar(
			`Generating ${ generateNamespace }/${ generateRoute }`,
			count,
			! flags.quiet
		);
		const created: unknown[] = [];
		try {
			for ( let i = 0; i < count; i++ ) {
				const index = i + 1;
				try {
					created.push(
						await sendGenerateRequest(
							index,
							buildGenerateFields( index )
						)
					);
				} catch ( error ) {
					const impliedFieldNames =
						hiddenRequiredFallbackArgs.length === 0 &&
						error instanceof WpApiError
							? HIDDEN_REQUIRED_FIELDS_BY_ERROR_CODE[ error.code ]
							: undefined;
					const fallbackEntries: Array<
						[ string, EndpointArgSchema ]
					> = impliedFieldNames
						? impliedFieldNames
								.map(
									( name ) =>
										[
											name,
											generateArgs?.[ name ],
										] as const
								)
								.filter(
									(
										entry
									): entry is [ string, EndpointArgSchema ] =>
										Boolean( entry[ 1 ] ) &&
										! ( entry[ 0 ] in createFields )
								)
						: [];

					if ( fallbackEntries.length ) {
						hiddenRequiredFallbackArgs.push( ...fallbackEntries );
						progress.log(
							`Note: the API rejected an empty item; also generating ${ fallbackEntries
								.map( ( [ name ] ) => `--${ name }` )
								.join( ', ' ) }.`
						);
						created.push(
							await sendGenerateRequest(
								index,
								buildGenerateFields( index )
							)
						);
						progress.tick();
						continue;
					}

					// `id_base` needs a value discovered from a live
					// request (see `resolveWidgetIdBase`), not one of
					// `HIDDEN_REQUIRED_FIELDS_BY_ERROR_CODE`'s synthesized
					// placeholders — handled as a separate fallback path.
					const canResolveIdBase =
						! ( 'id_base' in fixedFallbackFields ) &&
						generateArgs?.id_base &&
						! ( 'id_base' in createFields ) &&
						error instanceof WpApiError &&
						error.code === 'rest_invalid_widget';
					const discoveredIdBase = canResolveIdBase
						? await resolveWidgetIdBase(
								client,
								apiRoot,
								generateNamespace
						  )
						: undefined;
					if ( ! discoveredIdBase ) {
						throw error;
					}
					fixedFallbackFields.id_base = discoveredIdBase;
					progress.log(
						`Note: --id_base not supplied; using the first available widget type ("${ discoveredIdBase }").`
					);
					created.push(
						await sendGenerateRequest(
							index,
							buildGenerateFields( index )
						)
					);
				}
				progress.tick();
			}
		} finally {
			progress.finish();
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
	const verbArgs = await validateVerbFields(
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
	const uploadPlan =
		parsed.verb === 'create' || parsed.verb === 'update'
			? planUploads( {
					namespace: parsed.namespace,
					route: parsed.route,
					fields: parsed.fields,
					repeated: parsed.repeated,
					args: verbArgs,
			  } )
			: undefined;
	const requestFields = coerceJsonFields(
		uploadPlan ? uploadPlan.textFields : parsed.fields,
		verbArgs
	);
	const request = buildVerbRequest( {
		verb: parsed.verb,
		apiRoot,
		namespace: parsed.namespace,
		route: parsed.route,
		id: parsed.id,
		paramIndex,
		context: flags.context,
		fields: requestFields,
		bodyOverride: resolveBodyOverride( flags.body ),
		responseFields: flags.fields,
	} );

	if (
		uploadPlan &&
		( parsed.verb === 'create' || parsed.verb === 'update' )
	) {
		return runUploadCommand( {
			client,
			apiRoot,
			namespace: parsed.namespace,
			route: parsed.route,
			verb: parsed.verb,
			url: request.url,
			plan: uploadPlan,
			textFields: requestFields,
			flags,
		} );
	}

	const response = await withSpinner(
		`${ request.method } ${ parsed.namespace }/${ parsed.route }`,
		! flags.quiet,
		() =>
			client.request( request.url, {
				method: request.method,
				body: request.body,
			} )
	);
	const followed =
		parsed.verb === 'create'
			? await followCreatedLocation( client, apiRoot, response, flags )
			: undefined;
	const body = followed ? followed.body : response.body;

	if (
		( parsed.verb === 'create' && ! followed ) ||
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

	// Slug-keyed collections (types/taxonomies/statuses) are one object; show
	// one row per entry so `--fields`/`--format=ids` work like on any list.
	const rows =
		parsed.verb === 'list' &&
		isKeyedRoute( parsed.route ) &&
		body &&
		typeof body === 'object' &&
		! Array.isArray( body )
			? Object.values( body )
			: body;

	// WordPress reports the collection total in headers; surface it so callers
	// know when a page is partial, and so `--format=count` means "how many".
	const totalHeader =
		parsed.verb === 'list' ? response.headers.get( 'x-wp-total' ) : null;
	const total = totalHeader === null ? NaN : Number( totalHeader );
	const totalPagesHeader =
		parsed.verb === 'list'
			? response.headers.get( 'x-wp-totalpages' )
			: null;
	const totalPages =
		totalPagesHeader === null ? NaN : Number( totalPagesHeader );
	if ( totalPages > 1 ) {
		notice(
			`Page ${ parsed.fields.page ?? 1 } of ${ totalPages }${
				Number.isFinite( total ) ? ` (${ total } total)` : ''
			}. Use --page=<n> for more.`,
			! flags.quiet
		);
	}
	if (
		flags.format === 'count' &&
		! flags.field &&
		Number.isFinite( total )
	) {
		return { output: String( total ), exitCode: 0 };
	}

	const output = await formatOutput( rows, {
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
	const client = new WpRestClient( buildAuth( flags, siteUrl ), flags.debug );
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
		if ( flags.format === 'table' ) {
			const rows = buildChildRows( index, parsed.namespace, children );
			const output = renderChildListWpCli(
				`wp-rest-cli ${ parsed.namespace }`,
				[
					`Routes available under the "${ parsed.namespace }" namespace.`,
					'',
					`Run 'wp-rest-cli help ${ parsed.namespace } <route>' to get more information on a specific route.`,
				],
				`wp-rest-cli ${ parsed.namespace } <route>`,
				rows.map( ( row ) => ( {
					label: row.route,
					description: row.verbs,
				} ) )
			);
			return { output, exitCode: 0 };
		}
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
			if ( flags.format === 'table' ) {
				const rows = buildChildRows(
					index,
					parsed.namespace,
					children
				);
				const output = renderChildListWpCli(
					`wp-rest-cli ${ parsed.namespace } ${ displayRoute(
						parsed.route
					) }`,
					[
						`This route has no schema of its own — it's a pure container for the routes nested beneath it.`,
					],
					`wp-rest-cli ${ parsed.namespace } ${ displayRoute(
						parsed.route
					) } <route>`,
					rows.map( ( row ) => ( {
						label: row.route,
						description: row.verbs,
					} ) )
				);
				return { output, exitCode: 0 };
			}
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
		if ( flags.format !== 'table' ) {
			return {
				output: await formatOutput(
					routeHelpObject(
						index,
						parsed.namespace,
						parsed.route,
						schema,
						requiresParam,
						verbs,
						children,
						paramName
					),
					{
						format: flags.format === 'yaml' ? 'yaml' : 'json',
						color: false,
					}
				),
				exitCode: 0,
			};
		}
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
				renderChildrenNote(
					index,
					parsed.namespace,
					withMetaChild(
						children,
						parsed.route,
						schema.endpoints ?? []
					)
				),
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
	if ( flags.format !== 'table' ) {
		return {
			output: await formatOutput(
				{
					namespace: parsed.namespace,
					route: parsed.route,
					verb: parsed.verb,
					paramName,
					verbs,
					endpoints: withRequiredLists(
						( schema.endpoints ?? [] ).filter(
							( e ) =>
								! COLLECTION_VERB_METHOD[ parsed.verb ] ||
								e.methods.includes(
									COLLECTION_VERB_METHOD[
										parsed.verb
									] as string
								)
						)
					),
				},
				{
					format: flags.format === 'yaml' ? 'yaml' : 'json',
					color: false,
				}
			),
			exitCode: 0,
		};
	}
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
