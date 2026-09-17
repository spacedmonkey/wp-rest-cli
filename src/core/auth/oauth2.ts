/**
 * External dependencies
 */
import { randomBytes } from 'node:crypto';
import http from 'node:http';

/**
 * Internal dependencies
 */
import type { WpRestClient } from '../client.js';
import { CliError } from '../errors.js';
import {
	fetchIndex,
	getOAuth2Endpoints,
	type OAuth2Endpoints,
} from '../indexer.js';
import { canSiteUseApplicationPasswords } from './authorize.js';
import type { AuthProvider } from './types.js';

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/** The fixed local port `wp auth oauth2 login`'s callback server binds to by default. */
export const DEFAULT_OAUTH2_CALLBACK_PORT = 8787;

/** The fixed local path `wp auth oauth2 login`'s callback server listens on by default. */
export const DEFAULT_OAUTH2_CALLBACK_PATH = '/callback';

/**
 * Builds the default local redirect URI `wp auth oauth2 login` registers
 * with, and listens on, unless overridden via `redirect-uri=`/`port=`. Unlike
 * Application Passwords' browser flow (`core/auth/authorize.ts`), this can't
 * use an OS-assigned ephemeral port: the WP-API/OAuth2 plugin matches a
 * client's registered redirect URI exactly (scheme/host/port/path), so the
 * URI has to be known — and the same, every run — *before* the "Application"
 * is created by hand in wp-admin.
 * @param port The local port to bind to.
 * @return The full `http://127.0.0.1:<port>/callback` redirect URI.
 */
export function defaultOAuth2RedirectUri(
	port: number = DEFAULT_OAUTH2_CALLBACK_PORT
): string {
	return `http://127.0.0.1:${ port }${ DEFAULT_OAUTH2_CALLBACK_PATH }`;
}

/** Authenticates a request with a previously-obtained OAuth2 access token. */
export class OAuth2AuthProvider implements AuthProvider {
	/** @param accessToken The bearer token to send on every request. */
	constructor( private readonly accessToken: string ) {}

	/** @return An `Authorization: Bearer ...` header for the configured token. */
	async getHeaders(): Promise< Record< string, string > > {
		return { Authorization: `Bearer ${ this.accessToken }` };
	}
}

/**
 * The single shared gate both OAuth2 flows below call first, before any
 * browser tab, local server, or token-endpoint request: refuses to proceed
 * at all against a site that can't possibly support OAuth2 (plain HTTP,
 * non-loopback — RFC 6749 §3.1/§3.2/§2.3.1 all require TLS here, even though
 * the WP-API/OAuth2 plugin itself doesn't enforce it), or that doesn't
 * advertise OAuth2 support in its REST API index at all (the plugin likely
 * isn't installed/active).
 * @param  client  The REST client to fetch the site's index with.
 * @param  apiRoot The resolved REST API root.
 * @return The site's advertised OAuth2 endpoints.
 * @throws {CliError} If the site can't be used over plain HTTP, or doesn't advertise OAuth2 support.
 */
export async function assertOAuth2Supported(
	client: WpRestClient,
	apiRoot: string
): Promise< OAuth2Endpoints > {
	if ( ! canSiteUseApplicationPasswords( apiRoot ) ) {
		throw new CliError(
			'OAuth2 requires HTTPS (except on localhost/127.0.0.1) — RFC 6749 requires TLS for the ' +
				"authorization and token endpoints, and the WP-API/OAuth2 plugin doesn't enforce this " +
				'itself. Use an https:// URL.'
		);
	}

	const index = await fetchIndex( client, apiRoot );
	const endpoints = getOAuth2Endpoints( index );
	if ( ! endpoints ) {
		throw new CliError(
			"This site doesn't advertise OAuth2 support — the WP-API/OAuth2 plugin may not be " +
				'installed or active. Use "wp auth application-passwords login" instead, or check ' +
				'with the site administrator.'
		);
	}
	return endpoints;
}

/**
 * The port implied by a redirect URI, resolving to the scheme's own default
 * (80 for `http:`, 443 for `https:`) when the URI didn't spell one out
 * explicitly. `URL.port` alone can't be used for this: the WHATWG URL parser
 * blanks it to `''` whenever the given port already equals the scheme's
 * default (e.g. `new URL('http://127.0.0.1:80/x').port === ''`) — otherwise
 * indistinguishable from no port having been given at all, which would
 * previously make `Number(url.port)` come out `0` and silently bind an
 * OS-assigned ephemeral port instead of the one actually implied by the URI.
 * @param url The parsed redirect URI.
 * @return The port to bind/match against, or undefined for a scheme this isn't defined for.
 */
export function resolveRedirectUriPort( url: URL ): number | undefined {
	if ( url.port !== '' ) {
		return Number( url.port );
	}
	if ( url.protocol === 'http:' ) {
		return 80;
	}
	if ( url.protocol === 'https:' ) {
		return 443;
	}
	return undefined;
}

/**
 * Starts the fixed-address local HTTP callback server `runOAuth2AuthorizationCodeFlow`
 * waits on, resolving once the server is actually bound (so an `EADDRINUSE`
 * surfaces before the authorize URL is ever printed) with a promise for the
 * eventual authorization code.
 * @param redirectUri The parsed, fixed local redirect URI to bind to.
 * @param port        The port to bind to (see {@link resolveRedirectUriPort} — not read back off `redirectUri.port` here, since that can be blanked for a scheme-default port).
 * @param state       The `state` value this flow generated, to verify against the callback.
 * @param timeoutMs   How long to wait for the callback before giving up.
 * @return A promise for the server being ready, itself resolving to a promise for the authorization code.
 */
function startOAuth2CallbackServer(
	redirectUri: URL,
	port: number,
	state: string,
	timeoutMs: number
): Promise< { result: Promise< string > } > {
	return new Promise( ( resolveReady, rejectReady ) => {
		const server = http.createServer();

		// Registered before `listen()` so a bind failure (e.g. EADDRINUSE)
		// rejects this outer promise — critically, the callback-wait timeout
		// below is only armed *after* `listen()`'s own callback confirms the
		// server actually bound, so a failed bind can never leave a five-minute
		// timer running with nothing left to clear it (that dangling timer is
		// exactly what would otherwise keep the process alive well past the
		// point this promise already rejected).
		server.on( 'error', ( error: NodeJS.ErrnoException ) => {
			if ( error.code === 'EADDRINUSE' ) {
				rejectReady(
					new CliError(
						`Port ${ port } is already in use — pass a different "port=" or ` +
							'"redirect-uri=" field to "wp auth oauth2 login".'
					)
				);
				return;
			}
			rejectReady( error );
		} );

		server.listen( port, redirectUri.hostname, () => {
			let settled = false;

			const result = new Promise< string >(
				( resolveResult, rejectResult ) => {
					const timer = setTimeout( () => {
						if ( settled ) {
							return;
						}
						settled = true;
						server.closeAllConnections();
						server.close();
						rejectResult(
							new CliError(
								'Timed out waiting for authorization in the browser. Run "wp auth oauth2 login <url>" again.'
							)
						);
					}, timeoutMs );

					server.on( 'request', ( req, res ) => {
						const requestUrl = new URL(
							req.url ?? '/',
							'http://127.0.0.1'
						);
						if ( requestUrl.pathname !== redirectUri.pathname ) {
							res.writeHead( 404 ).end();
							return;
						}

						const error = requestUrl.searchParams.get( 'error' );
						const code = requestUrl.searchParams.get( 'code' );

						res.writeHead( 200, {
							'Content-Type': 'text/html; charset=utf-8',
							Connection: 'close',
						} );
						res.end(
							code && ! error
								? '<html><body><p>Authorization complete — you can close this window and return to the terminal.</p></body></html>'
								: '<html><body><p>Authorization was not completed — you can close this window.</p></body></html>'
						);

						if ( settled ) {
							return;
						}
						settled = true;
						clearTimeout( timer );
						server.close();

						const returnedState =
							requestUrl.searchParams.get( 'state' );
						if ( error ) {
							rejectResult(
								new CliError(
									`Authorization was denied (${ error }).`
								)
							);
						} else if ( returnedState !== state ) {
							rejectResult(
								new CliError(
									'Authorization callback state did not match — the request may have been tampered with. Try again.'
								)
							);
						} else if ( ! code ) {
							rejectResult(
								new CliError(
									'Authorization callback was missing an authorization code.'
								)
							);
						} else {
							resolveResult( code );
						}
					} );
				}
			);

			resolveReady( { result } );
		} );
	} );
}

/** An OAuth2 token obtained from either grant this CLI supports. */
export interface OAuth2TokenResult {
	accessToken: string;
}

/**
 * Runs the full browser-based OAuth2 `authorization_code` flow: checks the
 * site supports OAuth2 (and can be used at all — see {@link assertOAuth2Supported}),
 * binds the fixed local callback server, prints the authorize URL for the
 * user to open, waits for the redirect back, and exchanges the resulting
 * code for an access token.
 * @param client       The REST client to fetch the site's index with.
 * @param apiRoot      The resolved REST API root.
 * @param clientId     The OAuth2 client id of a manually-created wp-admin Application.
 * @param clientSecret The Application's client secret, if known (optional — the plugin doesn't enforce it for this grant, but it's sent when available for forward-compatibility).
 * @param redirectUri  The fixed local redirect URI to bind to and register with the request (must match the Application's registered redirect URI exactly).
 * @param print        How to print the authorize URL/status (defaults to writing to stdout).
 * @param timeoutMs    How long to wait for the browser callback before giving up.
 * @return The newly-issued access token.
 */
export async function runOAuth2AuthorizationCodeFlow(
	client: WpRestClient,
	apiRoot: string,
	clientId: string,
	clientSecret: string | undefined,
	redirectUri: string,
	print: ( line: string ) => void = ( line ) =>
		process.stdout.write( `${ line }\n` ),
	timeoutMs = DEFAULT_TIMEOUT_MS
): Promise< OAuth2TokenResult > {
	// Pure local validation, checked before anything network-related: a
	// redirect URI this function can't resolve a bind port for (i.e. neither
	// http nor https) would previously reach `startOAuth2CallbackServer` and
	// silently bind an OS-assigned ephemeral port instead of the address
	// actually implied by the URI — see `resolveRedirectUriPort`. Failing
	// fast here avoids that mismatch rather than starting a browser flow
	// that could never actually receive its own callback.
	const redirectUriUrl = new URL( redirectUri );
	const port = resolveRedirectUriPort( redirectUriUrl );
	if ( port === undefined ) {
		throw new CliError(
			`"redirect-uri=${ redirectUri }" must be an http:// or https:// URL.`
		);
	}

	const endpoints = await assertOAuth2Supported( client, apiRoot );
	if ( ! endpoints.authorization ) {
		throw new CliError(
			"This site's OAuth2 support doesn't advertise an authorization endpoint, so the browser " +
				'login flow is unavailable. If the Application has the client_credentials grant ' +
				'enabled, use "wp auth oauth2 add" instead.'
		);
	}

	const state = randomBytes( 16 ).toString( 'hex' );

	const { result } = await startOAuth2CallbackServer(
		redirectUriUrl,
		port,
		state,
		timeoutMs
	);

	const authorizeUrl = new URL( endpoints.authorization, apiRoot );
	authorizeUrl.searchParams.set( 'response_type', 'code' );
	authorizeUrl.searchParams.set( 'client_id', clientId );
	authorizeUrl.searchParams.set( 'redirect_uri', redirectUri );
	authorizeUrl.searchParams.set( 'state', state );

	print(
		`Open this URL in your browser to authorize wp-rest-cli:\n\n  ${ authorizeUrl.toString() }\n\nWaiting for authorization...`
	);

	const code = await result;

	const tokenUrl = new URL( endpoints.token, apiRoot ).toString();
	const body = new URLSearchParams( {
		grant_type: 'authorization_code',
		client_id: clientId,
		code,
		redirect_uri: redirectUri,
		...( clientSecret ? { client_secret: clientSecret } : {} ),
	} ).toString();

	const { body: tokenResponse } = await client.request< {
		access_token?: string;
	} >( tokenUrl, {
		method: 'POST',
		body,
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		timeoutMs: 20_000,
	} );

	if ( ! tokenResponse?.access_token ) {
		throw new CliError(
			'The token endpoint did not return an access token.'
		);
	}

	return { accessToken: tokenResponse.access_token };
}

/**
 * Exchanges a client id/secret for an access token via the `client_credentials`
 * grant — no browser involved. Checks the site supports OAuth2 first (see
 * {@link assertOAuth2Supported}): no request is sent at all to a site that
 * doesn't advertise support.
 * @param client         The REST client to fetch the site's index with.
 * @param apiRoot        The resolved REST API root.
 * @param clientId       The OAuth2 client id of a manually-created wp-admin Application.
 * @param clientSecret   The Application's client secret.
 * @param diagnosticCode TEMPORARY, diagnostic-only: sends an arbitrary `code=`
 *                       body param alongside the request, to help confirm
 *                       server-side whether a site's deployed WP-API/OAuth2
 *                       code actually special-cases `client_credentials`
 *                       before falling through to its `authorization_code`
 *                       validation. `client_credentials` has no real code to
 *                       exchange — remove this parameter once diagnosis is done.
 * @return The newly-issued access token.
 */
export async function fetchOAuth2ClientCredentialsToken(
	client: WpRestClient,
	apiRoot: string,
	clientId: string,
	clientSecret: string,
	diagnosticCode?: string
): Promise< OAuth2TokenResult > {
	const endpoints = await assertOAuth2Supported( client, apiRoot );

	const tokenUrl = new URL( endpoints.token, apiRoot ).toString();
	// Sent both ways — as body params AND via HTTP Basic auth below — rather
	// than relying on Basic auth alone. The WP-API/OAuth2 plugin's own token
	// endpoint checks body params first specifically to sidestep proxies/CDNs
	// that strip or mangle the Authorization header before it reaches PHP (a
	// real, common hosting-config gotcha); sending only the fallback transport
	// leaves that failure mode unnecessarily reachable.
	const body = new URLSearchParams( {
		grant_type: 'client_credentials',
		client_id: clientId,
		client_secret: clientSecret,
		...( diagnosticCode ? { code: diagnosticCode } : {} ),
	} ).toString();
	const basicAuth = Buffer.from(
		`${ clientId }:${ clientSecret }`,
		'utf8'
	).toString( 'base64' );

	try {
		const { body: tokenResponse } = await client.request< {
			access_token?: string;
		} >( tokenUrl, {
			method: 'POST',
			body,
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
				Authorization: `Basic ${ basicAuth }`,
			},
			timeoutMs: 20_000,
		} );
		if ( ! tokenResponse?.access_token ) {
			throw new CliError(
				'The token endpoint did not return an access token.'
			);
		}
		return { accessToken: tokenResponse.access_token };
	} catch ( error ) {
		// Every failure here is wrapped with this hint, not just non-CliError
		// ones: a real OAuth2 token-endpoint error body (`{error: "..."}`)
		// doesn't match WordPress's own `{code, message, data}` REST error
		// shape, so `parseErrorResponse` (`core/errors.ts`) always turns it
		// into a generic `CliError`, not a `WpApiError` — a narrower
		// "only wrap non-CliError errors" check would make this hint
		// effectively unreachable for the one case it exists for.
		throw new CliError(
			'Could not obtain a token via client_credentials — this Application may not have that ' +
				'grant enabled. In wp-admin, check Users → Applications → this application → ' +
				'"Client Credentials Grant" ("Allow this application to obtain tokens using the ' +
				`client_credentials grant."). Original error: ${
					error instanceof Error ? error.message : String( error )
				}`
		);
	}
}
