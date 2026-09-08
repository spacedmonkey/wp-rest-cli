/** The REST API's `context` query param, controlling which fields a response includes. */
export type Context = 'view' | 'edit' | 'embed';

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
