/** The REST API's `context` query param, controlling which fields a response includes. */
export type Context = 'view' | 'edit' | 'embed';

/**
 * A `--use-auth` value: pins credential resolution to exactly one source in
 * `buildAuth`'s normal `WP_USERNAME`/`WP_PASSWORD` env vars → stored `wp auth`
 * credential fallback chain, erroring if that source has nothing available
 * rather than silently falling through to the next one. `none` skips both,
 * forcing an anonymous request even if env vars or a stored credential exist.
 * An explicit `--username`/`--password` flag pair always wins regardless.
 *
 * A non-`env`/`none` value names a `wp auth` type (`application-passwords` or
 * `oauth2`) rather than the generic word "stored" — deliberately, since a site
 * can now store a credential of each type at once, so "the stored credential"
 * is ambiguous and this needs to say *which* type's. This mirrors `AuthType`
 * (`core/auth/types.ts`) by hand rather than importing it, the same way
 * `OutputFormat`/`FORMATS` and `Context`/`CONTEXTS` are each kept in sync by
 * hand elsewhere in this file/`cli.ts` — `types.ts` sits below `core/`, so it
 * can't import from it without inverting that layering.
 */
export type AuthSource = 'env' | 'none' | 'application-passwords' | 'oauth2';

/** A `--format` value accepted by `formatOutput`. */
export type OutputFormat =
	| 'table'
	| 'json'
	| 'csv'
	| 'yaml'
	| 'ids'
	| 'count'
	| 'raw';

/** One argument's schema, as returned in a route's OPTIONS response. */
export interface EndpointArgSchema {
	description?: string;
	type?: string | string[];
	enum?: string[];
	default?: unknown;
	required?: boolean;
	context?: string[];
	format?: string;
	properties?: Record< string, EndpointArgSchema >;
	readonly?: boolean;
	[ key: string ]: unknown;
}

/** One HTTP method's schema for a route, as returned in its OPTIONS response. */
export interface RouteEndpoint {
	methods: string[];
	args?: Record< string, EndpointArgSchema >;
	[ key: string ]: unknown;
}

/** A route's full OPTIONS response: every method it supports and each one's argument schema. */
export interface RouteSchema {
	namespace: string;
	methods: string[];
	endpoints: RouteEndpoint[];
	_links?: Record< string, Array< { href: string } > >;
	[ key: string ]: unknown;
}

/** The site's root REST API index: namespaces, routes, and site metadata. */
export interface IndexResponse {
	name?: string;
	description?: string;
	url?: string;
	home?: string;
	namespaces: string[];
	authentication?: {
		'application-passwords'?: {
			endpoints?: { authorization?: string };
		};
		oauth2?: {
			endpoints?: { authorization?: string; token?: string };
			grant_types?: string[];
		};
		[ key: string ]: unknown;
	};
	routes: Record< string, RouteSchema >;
}

/** The `{code, message, data}` shape of a WordPress REST API error response body. */
export interface WpApiErrorBody {
	code: string;
	message: string;
	data?: {
		status?: number;
		params?: Record< string, string >;
		[ key: string ]: unknown;
	};
}

/** A username/password pair, as accepted by `BasicAuthProvider`. */
export interface AuthCredentials {
	username: string;
	password: string;
}

/** CLI flags shared across every namespace/route/verb command. */
export interface GlobalFlags {
	url?: string;
	username?: string;
	password?: string;
	useAuth?: AuthSource;
	context: Context;
	format: OutputFormat;
	fields?: string;
	field?: string;
	content?: string;
	color: boolean;
	quiet: boolean;
	debug: boolean;
}

/** One of the CLI's own verbs (not a raw HTTP method). */
export type Verb =
	| 'list'
	| 'get'
	| 'create'
	| 'update'
	| 'delete'
	| 'exists'
	| 'generate';
