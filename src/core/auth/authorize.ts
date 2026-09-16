/**
 * External dependencies
 */
import http from 'node:http';

/**
 * Internal dependencies
 */
import type { WpRestClient } from '../client.js';
import { CliError } from '../errors.js';
import {
	fetchIndex,
	getApplicationPasswordAuthorizationUrl,
} from '../indexer.js';
import { APPLICATION_PASSWORDS_AUTH_TYPE } from './types.js';

/** A newly-issued Application Password, as reported by WordPress's authorize-application.php callback. */
export interface AuthorizedCredential {
	userLogin: string;
	password: string;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Whether a URL's host is a loopback address — WordPress core allows
 * Application Passwords over plain HTTP for these, since there's no
 * network to eavesdrop on.
 * @param url The URL to check.
 * @return Whether `url`'s hostname is a loopback address.
 */
function isLocalHost( url: URL ): boolean {
	return (
		url.hostname === 'localhost' ||
		url.hostname === '127.0.0.1' ||
		url.hostname === '::1' ||
		url.hostname === '[::1]'
	);
}

/**
 * Builds the full `/wp-admin/authorize-application.php` URL to send the
 * user's browser to, with the app name pre-filled and WordPress told where
 * to redirect once the user approves.
 * @param apiRoot               The resolved REST API root, used to resolve a
 *                              site-relative authorization endpoint against.
 * @param authorizationEndpoint The site's advertised authorization endpoint
 *                              (absolute or site-relative).
 * @param appName               The application name to pre-fill.
 * @param successUrl            Where WordPress should redirect on approval.
 * @return The full authorization URL to open in a browser.
 */
export function buildAuthorizationUrl(
	apiRoot: string,
	authorizationEndpoint: string,
	appName: string,
	successUrl: string
): string {
	const authorizeUrl = new URL( authorizationEndpoint, apiRoot );
	authorizeUrl.searchParams.set( 'app_name', appName );
	authorizeUrl.searchParams.set( 'success_url', successUrl );
	return authorizeUrl.toString();
}

/**
 * Whether Application Passwords can possibly be available at this API root —
 * WordPress requires HTTPS, except for a loopback address (a developer
 * opting in on local dev). Doesn't guarantee the site actually has the
 * feature enabled, only that it isn't ruled out by scheme/host alone.
 * @param apiRoot The resolved REST API root URL.
 * @return Whether the site's scheme/host rules out Application Passwords support.
 */
export function canSiteUseApplicationPasswords( apiRoot: string ): boolean {
	const url = new URL( apiRoot );
	return url.protocol !== 'http:' || isLocalHost( url );
}

/**
 * The specific reason a site can't run the Application Password
 * authorization flow, so `wp auth application-passwords login` can point the
 * user at a working fallback (`wp auth application-passwords add`) instead of
 * a generic "not supported" message.
 * @param apiRoot The resolved REST API root the site doesn't advertise
 *                Application Passwords support at.
 * @return A `CliError` describing why, and what to do instead.
 */
function buildUnsupportedError( apiRoot: string ): CliError {
	const isHttpOnly = ! canSiteUseApplicationPasswords( apiRoot );
	if ( isHttpOnly ) {
		return new CliError(
			'This site does not advertise Application Passwords support. WordPress disables ' +
				'Application Passwords over plain HTTP (except on localhost) — use an https:// URL, ' +
				`or store a regular account password instead with: wp auth ${ APPLICATION_PASSWORDS_AUTH_TYPE } add <url> --username=<u> --password=<p>`
		);
	}
	return new CliError(
		'This site does not support Application Passwords (requires WordPress 5.6+ with the ' +
			`feature enabled). Use: wp auth ${ APPLICATION_PASSWORDS_AUTH_TYPE } add <url> --username=<u> --password=<p>`
	);
}

/**
 * Starts a short-lived local HTTP server on an OS-assigned loopback port to
 * receive WordPress's authorize-application.php redirect, resolving once the
 * callback arrives (or rejecting on timeout).
 * @param timeoutMs How long to wait for the callback before giving up.
 * @return The assigned port to build `success_url` from, and a promise for
 *         the resulting credential.
 */
function startCallbackServer( timeoutMs: number ): Promise< {
	port: number;
	result: Promise< AuthorizedCredential >;
} > {
	return new Promise( ( resolveServer, rejectServer ) => {
		const server = http.createServer();
		let settled = false;

		const shutdown = () => {
			server.closeAllConnections();
			server.close();
		};

		const result = new Promise< AuthorizedCredential >(
			( resolveResult, rejectResult ) => {
				const timer = setTimeout( () => {
					if ( settled ) {
						return;
					}
					settled = true;
					shutdown();
					rejectResult(
						new CliError(
							`Timed out waiting for authorization in the browser. Run "wp auth ${ APPLICATION_PASSWORDS_AUTH_TYPE } login <url>" again.`
						)
					);
				}, timeoutMs );

				server.on( 'request', ( req, res ) => {
					const requestUrl = new URL(
						req.url ?? '/',
						'http://127.0.0.1'
					);
					if ( requestUrl.pathname !== '/callback' ) {
						res.writeHead( 404 ).end();
						return;
					}

					const userLogin =
						requestUrl.searchParams.get( 'user_login' );
					const password = requestUrl.searchParams.get( 'password' );

					res.writeHead( 200, {
						'Content-Type': 'text/html; charset=utf-8',
						Connection: 'close',
					} );
					res.end(
						userLogin && password
							? '<html><body><p>Authorization complete — you can close this window and return to the terminal.</p></body></html>'
							: '<html><body><p>Authorization was not completed — you can close this window.</p></body></html>'
					);

					if ( settled ) {
						return;
					}
					settled = true;
					clearTimeout( timer );
					server.close();
					if ( userLogin && password ) {
						resolveResult( { userLogin, password } );
					} else {
						rejectResult(
							new CliError(
								'Authorization was denied, or the callback was missing credentials.'
							)
						);
					}
				} );
			}
		);

		server.on( 'error', ( error ) => rejectServer( error ) );
		server.listen( 0, '127.0.0.1', () => {
			const address = server.address();
			if ( address === null || typeof address === 'string' ) {
				rejectServer(
					new CliError(
						'Could not start the local authorization callback server.'
					)
				);
				return;
			}
			resolveServer( { port: address.port, result } );
		} );
	} );
}

/**
 * Runs the full browser-based Application Password registration flow: checks
 * the site supports it, starts a local callback server, prints the
 * authorize-application.php URL for the user to open, and waits for
 * WordPress to redirect back with the new credential.
 * @param client    The REST client to fetch the site's index with.
 * @param apiRoot   The resolved REST API root.
 * @param appName   The application name to pre-fill on the authorization page.
 * @param print     How to print the authorize URL/status (defaults to writing to stdout).
 * @param timeoutMs How long to wait for the browser callback before giving up.
 * @return The newly-issued username/Application Password pair.
 */
export async function runAuthorizationFlow(
	client: WpRestClient,
	apiRoot: string,
	appName: string,
	print: ( line: string ) => void = ( line ) =>
		process.stdout.write( `${ line }\n` ),
	timeoutMs = DEFAULT_TIMEOUT_MS
): Promise< AuthorizedCredential > {
	const index = await fetchIndex( client, apiRoot );
	const authorizationEndpoint =
		getApplicationPasswordAuthorizationUrl( index );
	if ( ! authorizationEndpoint ) {
		throw buildUnsupportedError( apiRoot );
	}

	const { port, result } = await startCallbackServer( timeoutMs );
	const successUrl = `http://127.0.0.1:${ port }/callback`;
	const authorizeUrl = buildAuthorizationUrl(
		apiRoot,
		authorizationEndpoint,
		appName,
		successUrl
	);

	print(
		`Open this URL in your browser to authorize wp-rest-cli:\n\n  ${ authorizeUrl }\n\nWaiting for authorization...`
	);

	return result;
}
