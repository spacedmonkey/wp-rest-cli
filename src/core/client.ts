/**
 * WordPress dependencies
 */
import { addQueryArgs } from '@wordpress/url';

/**
 * Internal dependencies
 */
import type { WpApiErrorBody } from '../types.js';
import type { AuthProvider } from './auth/types.js';
import { debugLog, redactBody, redactHeaders } from './debug.js';
import { CliError, parseErrorResponse, WpApiError } from './errors.js';
import { timedFetch } from './timeout.js';

/** Default timeout for an API request, in milliseconds (override with `--timeout`). */
const DEFAULT_TIMEOUT_MS = 20_000;

export interface RequestOptions {
	method?: string;
	query?: Record< string, string | number | boolean | undefined >;
	body?: unknown;
	headers?: Record< string, string >;
	timeoutMs?: number;
}

export interface WpResponse< T = unknown > {
	status: number;
	headers: Headers;
	body: T;
}

interface Envelope {
	body: unknown;
	status: number;
	headers: Record< string, unknown >;
}

/**
 * Whether a parsed response is a WordPress `_envelope` wrapper.
 * @param value The parsed JSON response.
 * @return True if it has the `{ body, status, headers }` shape.
 */
function isEnvelope( value: unknown ): value is Envelope {
	const v = value as Envelope | undefined;
	return (
		!! v &&
		typeof v === 'object' &&
		'body' in v &&
		typeof v.status === 'number' &&
		v.status >= 100 &&
		v.status <= 599 &&
		!! v.headers &&
		typeof v.headers === 'object'
	);
}

/**
 * Logs response headers (credential-bearing ones masked) to stderr.
 * @param headers Header name/value pairs.
 */
function logHeaders( headers: Record< string, unknown > ): void {
	const strings: Record< string, string > = {};
	for ( const [ key, value ] of Object.entries( headers ) ) {
		strings[ key ] = String( value );
	}
	for ( const [ key, value ] of Object.entries( redactHeaders( strings ) ) ) {
		debugLog( `  ${ key }: ${ value }` );
	}
}

/**
 * Logs an envelope's headers (plus any real HTTP headers it lacks), then
 * returns its body, or throws the same typed error a real 4xx/5xx would.
 * @param envelope    The parsed `{ body, status, headers }` wrapper.
 * @param httpHeaders The real HTTP response headers.
 * @return The unwrapped response.
 */
async function unwrapEnvelope< T >(
	envelope: Envelope,
	httpHeaders: Headers
): Promise< WpResponse< T > > {
	const all: Record< string, unknown > = { ...envelope.headers };
	const seen = new Set( Object.keys( all ).map( ( k ) => k.toLowerCase() ) );
	// Real HTTP headers not in the envelope, e.g. Query Monitor's `X-QM-*`,
	// which PHP emits outside the REST response object.
	for ( const [ key, value ] of httpHeaders ) {
		if ( ! seen.has( key ) && key !== 'set-cookie' ) {
			all[ key ] = value;
		}
	}
	if ( httpHeaders.getSetCookie().length ) {
		all[ 'set-cookie' ] = '';
	}
	debugLog( `  envelope status: ${ envelope.status }` );
	logHeaders( all );

	const headers = new Headers();
	for ( const [ key, value ] of Object.entries( envelope.headers ) ) {
		try {
			headers.set( key, String( value ) );
		} catch {
			// A malformed header must not hide the response itself.
		}
	}
	if ( envelope.status >= 400 ) {
		const err = envelope.body as Partial< WpApiErrorBody > | null;
		if (
			typeof err?.code === 'string' &&
			typeof err.message === 'string'
		) {
			throw new WpApiError(
				err as WpApiErrorBody,
				envelope.status,
				headers
			);
		}
		throw new CliError(
			`Request failed with status ${ envelope.status }`,
			headers
		);
	}
	return {
		status: envelope.status,
		headers,
		body: ( envelope.body ?? undefined ) as T,
	};
}

/** Thin `fetch` wrapper that attaches auth headers and turns non-2xx responses into a `WpApiError`. */
export class WpRestClient {
	/**
	 * @param auth  Auth provider used to attach request headers, if any.
	 * @param debug Whether to log request/response diagnostics via {@link debugLog}.
	 */
	constructor(
		private readonly auth?: AuthProvider,
		private readonly debug = false
	) {}

	/**
	 * The auth headers this client attaches to every request, for callers
	 * (like the streaming file upload) that issue their own HTTP request.
	 * @return The headers, or an empty object when unauthenticated.
	 */
	async authHeaders(): Promise< Record< string, string > > {
		return this.auth ? await this.auth.getHeaders() : {};
	}

	/**
	 * Issues an HTTP request against the REST API, JSON-encoding the body and
	 * decoding the response.
	 * @param url     The absolute URL to request.
	 * @param options Method, query params, body, headers, and timeout.
	 * @return The response status, headers, and parsed JSON body.
	 */
	async request< T = unknown >(
		url: string,
		options: RequestOptions = {}
	): Promise< WpResponse< T > > {
		// Under --debug, ask WordPress to wrap the response as
		// `{ body, status, headers }` so its headers can be logged.
		const envelope = this.debug && options.method !== 'HEAD';
		const target = new URL(
			envelope ? addQueryArgs( url, { _envelope: true } ) : url
		);
		if ( options.query ) {
			for ( const [ key, value ] of Object.entries( options.query ) ) {
				if ( value !== undefined ) {
					target.searchParams.set( key, String( value ) );
				}
			}
		}

		const authHeaders = this.auth ? await this.auth.getHeaders() : {};
		const headers: Record< string, string > = {
			Accept: 'application/json',
			...authHeaders,
			...options.headers,
		};

		let body: string | undefined;
		if ( options.body !== undefined ) {
			body =
				typeof options.body === 'string'
					? options.body
					: JSON.stringify( options.body );
			headers[ 'Content-Type' ] =
				headers[ 'Content-Type' ] ?? 'application/json';
		}

		const method = options.method ?? 'GET';
		if ( this.debug ) {
			debugLog( `→ ${ method } ${ target.toString() }` );
			for ( const [ key, value ] of Object.entries(
				redactHeaders( headers )
			) ) {
				debugLog( `  ${ key }: ${ value }` );
			}
			if ( body ) {
				debugLog(
					`  body: ${ redactBody( body, headers[ 'Content-Type' ] ) }`
				);
			}
		}

		const startedAt = Date.now();
		const response = await timedFetch(
			target,
			{ method, headers, body },
			options.timeoutMs ?? DEFAULT_TIMEOUT_MS
		);

		if ( this.debug ) {
			debugLog(
				`← ${ response.status } ${ response.statusText } (${
					Date.now() - startedAt
				}ms)`
			);
		}

		if ( ! response.ok ) {
			if ( this.debug ) {
				logHeaders( Object.fromEntries( response.headers ) );
			}
			throw await parseErrorResponse( response );
		}

		if ( options.method === 'HEAD' ) {
			return {
				status: response.status,
				headers: response.headers,
				body: undefined as T,
			};
		}

		const text = await response.text();
		const parsed: unknown = text ? JSON.parse( text ) : undefined;
		if ( envelope && isEnvelope( parsed ) ) {
			return await unwrapEnvelope< T >( parsed, response.headers );
		}
		if ( envelope ) {
			debugLog( '  (site did not honor _envelope; no headers to show)' );
		}
		return {
			status: response.status,
			headers: response.headers,
			body: parsed as T,
		};
	}
}
