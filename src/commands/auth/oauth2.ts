/**
 * Internal dependencies
 */
import {
	getDefaultUrl,
	getSiteCredential,
	listSiteCredentials,
	normalizeSiteUrl,
	removeSiteCredential,
	setDefaults,
	setSiteCredential,
	type SiteCredentialRow,
} from '../../config.js';
import {
	defaultOAuth2RedirectUri,
	fetchOAuth2ClientCredentialsToken,
	OAuth2AuthProvider,
	runOAuth2AuthorizationCodeFlow,
} from '../../core/auth/oauth2.js';
import { OAUTH2_AUTH_TYPE } from '../../core/auth/types.js';
import { WpRestClient } from '../../core/client.js';
import { resolveApiRoot } from '../../core/discovery.js';
import { CliError } from '../../core/errors.js';
import { formatOutput } from '../../core/formatter.js';
import type { GlobalFlags } from '../../types.js';
import { withSpinner, pc, success, warn } from '../../ui.js';
import type { AuthResult, ParsedAuth } from '../auth.js';

/**
 * Narrows a {@link SiteCredentialRow} to its oauth2 member —
 * `listSiteCredentials()` returns rows for every stored auth type, and each
 * type's own handlers filter to their own rows client-side.
 * @param site A row from `listSiteCredentials()`.
 * @return Whether `site` is an oauth2 row.
 */
function isOAuth2Row(
	site: SiteCredentialRow
): site is Extract< SiteCredentialRow, { authType: typeof OAUTH2_AUTH_TYPE } > {
	return site.authType === OAUTH2_AUTH_TYPE;
}

/**
 * `wp auth oauth2 login <url> --client-id=<id> [...]`: runs the browser-based
 * `authorization_code` flow against a manually-created wp-admin Application,
 * then stores the resulting access token. Re-running `login` for the same
 * site overwrites the stored token silently — the WP-API/OAuth2 plugin
 * exposes no REST endpoint to revoke the old one, unlike Application
 * Passwords' `login`.
 * @param parsed The parsed `login` command.
 * @param flags  Global CLI flags — `--client-id`/`--client-secret` (the
 *               credential itself) live here rather than on `parsed`, the
 *               same way `--username`/`--password` do for
 *               application-passwords.
 * @return The command's rendered output and exit code.
 */
async function handleLogin(
	parsed: Extract<
		ParsedAuth,
		{ mode: 'login'; authType: typeof OAUTH2_AUTH_TYPE }
	>,
	flags: GlobalFlags
): Promise< AuthResult > {
	if ( ! flags.clientId ) {
		throw new CliError(
			`wp auth ${ OAUTH2_AUTH_TYPE } login requires --client-id, from a manually-created wp-admin Application (Users → Applications).`
		);
	}

	const apiRoot = await withSpinner(
		'Discovering REST API',
		! flags.quiet,
		() => resolveApiRoot( parsed.url, flags.debug )
	);
	const client = new WpRestClient( undefined, flags.debug );
	const redirectUri =
		parsed.redirectUri ?? defaultOAuth2RedirectUri( parsed.port );

	const hadPrevious = Boolean(
		getSiteCredential( parsed.url, OAUTH2_AUTH_TYPE )
	);

	const { accessToken } = await runOAuth2AuthorizationCodeFlow(
		client,
		apiRoot,
		flags.clientId,
		flags.clientSecret,
		redirectUri
	);

	setSiteCredential( parsed.url, OAUTH2_AUTH_TYPE, {
		accessToken,
		clientId: flags.clientId,
		grantType: 'authorization_code',
		tokenType: 'bearer',
	} );

	const note = hadPrevious
		? ' Replaced the previously stored OAuth2 token for this site — the old one could not be revoked automatically (the WP-API/OAuth2 plugin exposes no REST revocation endpoint); revoke it manually in wp-admin if needed.'
		: '';

	return {
		output: success(
			`Saved an OAuth2 access token for ${ normalizeSiteUrl(
				parsed.url
			) }.${ note }`
		),
		exitCode: 0,
	};
}

/**
 * `wp auth oauth2 add <url> --client-id=<id> --client-secret=<secret>`:
 * exchanges a client id/secret for an access token via `client_credentials`
 * (no browser), then stores it. Best-effort verifies the token against
 * `wp/v2/users/me`, but treats the result as inconclusive-not-authoritative —
 * a `client_credentials` token authenticates as user id 0, which some
 * routes' permission callbacks may reject regardless of a valid token — so
 * this never blocks the save, only warns.
 * @param parsed The parsed `add` command.
 * @param flags  Global CLI flags — `--client-id`/`--client-secret` (the
 *               credential itself) live here rather than on `parsed`, the
 *               same way `--username`/`--password` do for
 *               application-passwords.
 * @return The command's rendered output and exit code.
 */
async function handleAdd(
	parsed: Extract<
		ParsedAuth,
		{ mode: 'add'; authType: typeof OAUTH2_AUTH_TYPE }
	>,
	flags: GlobalFlags
): Promise< AuthResult > {
	if ( ! flags.clientId || ! flags.clientSecret ) {
		throw new CliError(
			`wp auth ${ OAUTH2_AUTH_TYPE } add requires both --client-id and --client-secret, from a manually-created wp-admin Application with the client_credentials grant enabled.`
		);
	}

	const apiRoot = await withSpinner(
		'Discovering REST API',
		! flags.quiet,
		() => resolveApiRoot( parsed.url, flags.debug )
	);
	const client = new WpRestClient( undefined, flags.debug );
	const { accessToken } = await fetchOAuth2ClientCredentialsToken(
		client,
		apiRoot,
		flags.clientId,
		flags.clientSecret
	);

	let warning: string | undefined;
	try {
		const verifyClient = new WpRestClient(
			new OAuth2AuthProvider( accessToken ),
			flags.debug
		);
		await verifyClient.request(
			new URL( 'wp/v2/users/me', apiRoot ).toString(),
			{ timeoutMs: 8000 }
		);
	} catch {
		warning =
			'Could not verify this token against wp/v2/users/me — expected for some sites, since client_credentials tokens have no real user context. Saving anyway.';
	}

	setSiteCredential( parsed.url, OAUTH2_AUTH_TYPE, {
		accessToken,
		clientId: flags.clientId,
		grantType: 'client_credentials',
		tokenType: 'bearer',
	} );

	const successLine = success(
		`Saved an OAuth2 access token for ${ normalizeSiteUrl( parsed.url ) }.`
	);
	const output = warning
		? `${ warn( warning ) }\n${ successLine }`
		: successLine;

	return { output, exitCode: 0 };
}

/**
 * `wp auth oauth2 list`: every stored site's URL/client id/grant type, never
 * the access token itself.
 * @param flags Global CLI flags.
 * @return The command's rendered output and exit code.
 */
async function handleList( flags: GlobalFlags ): Promise< AuthResult > {
	const sites = listSiteCredentials().filter( isOAuth2Row );
	if ( ! sites.length ) {
		return {
			output: pc.dim(
				`No stored credentials. Use "wp auth ${ OAUTH2_AUTH_TYPE } login <url> client-id=<id>" or "wp auth ${ OAUTH2_AUTH_TYPE } add <url> client-id=<id> client-secret=<secret>".`
			),
			exitCode: 0,
		};
	}
	const defaultUrl = getDefaultUrl();
	const normalizedDefault = defaultUrl
		? normalizeSiteUrl( defaultUrl )
		: undefined;
	const rows = sites.map( ( site ) => ( {
		url: site.url,
		clientId: site.clientId,
		grantType: site.grantType,
		default: site.url === normalizedDefault ? '*' : '',
	} ) );
	const output = await formatOutput( rows, {
		format: flags.format,
		fields: flags.fields,
		field: flags.field,
		color: flags.color,
	} );
	return { output, exitCode: 0 };
}

/**
 * `wp auth oauth2 remove <url>`: forgets the stored token locally. The
 * WP-API/OAuth2 plugin exposes no REST revocation endpoint, unlike
 * Application Passwords, so there's nothing to attempt remotely.
 * @param parsed The parsed `remove` command.
 * @return The command's rendered output and exit code.
 */
function handleRemove(
	parsed: Extract< ParsedAuth, { mode: 'remove' } >
): AuthResult {
	const removed = removeSiteCredential( parsed.url, OAUTH2_AUTH_TYPE );
	if ( ! removed ) {
		throw new CliError(
			`No stored OAuth2 credential for ${ normalizeSiteUrl(
				parsed.url
			) }.`
		);
	}
	return {
		output: success(
			`Removed the stored OAuth2 credential for ${ normalizeSiteUrl(
				parsed.url
			) } locally. The WP-API/OAuth2 plugin exposes no REST endpoint to revoke it on the site — do that manually in wp-admin if needed.`
		),
		exitCode: 0,
	};
}

/**
 * `wp auth oauth2 remove --all`: forgets every stored oauth2 credential —
 * purely local, nothing to revoke remotely. Scoped to this auth type only: a
 * site's stored application-passwords credential (if any) is left untouched.
 * @return The command's rendered output and exit code.
 */
function handleRemoveAll(): AuthResult {
	const sites = listSiteCredentials().filter( isOAuth2Row );
	if ( ! sites.length ) {
		return {
			output: pc.dim( 'No stored credentials to remove.' ),
			exitCode: 0,
		};
	}
	for ( const site of sites ) {
		removeSiteCredential( site.url, OAUTH2_AUTH_TYPE );
	}
	return {
		output: success(
			`Removed ${ sites.length } stored OAuth2 credential(s) locally. The WP-API/OAuth2 plugin exposes no REST endpoint to revoke them on their sites — do that manually in wp-admin if needed.`
		),
		exitCode: 0,
	};
}

/**
 * `wp auth oauth2 use <url>`: sets the default `--url` (same mechanism
 * `wp config set --url=` uses).
 * @param parsed The parsed `use` command.
 * @return The command's rendered output and exit code.
 */
function handleUse(
	parsed: Extract< ParsedAuth, { mode: 'use' } >
): AuthResult {
	setDefaults( { url: parsed.url } );
	return {
		output: success(
			`${ normalizeSiteUrl( parsed.url ) } is now the default site.`
		),
		exitCode: 0,
	};
}

/**
 * `wp auth oauth2 status`: the current default site, and whether an oauth2
 * credential is stored for it.
 * @return The command's rendered output and exit code.
 */
function handleStatus(): AuthResult {
	const defaultUrl = getDefaultUrl();
	if ( ! defaultUrl ) {
		return {
			output: pc.dim(
				`No default site set. Use "wp auth ${ OAUTH2_AUTH_TYPE } use <url>" or "wp config set --url=<url>".`
			),
			exitCode: 0,
		};
	}
	const credential = getSiteCredential( defaultUrl, OAUTH2_AUTH_TYPE );
	const lines = [
		`default site: ${ defaultUrl }`,
		credential
			? pc.green(
					`authenticated via OAuth2 (client ${ credential.clientId }, ${ credential.grantType })`
			  )
			: pc.dim(
					`no stored OAuth2 credential for this site — run "wp auth ${ OAUTH2_AUTH_TYPE } login <url> client-id=<id>" or "wp auth ${ OAUTH2_AUTH_TYPE } add <url> client-id=<id> client-secret=<secret>".`
			  ),
	];
	return { output: lines.join( '\n' ), exitCode: 0 };
}

/**
 * Executes a parsed `wp auth oauth2` command: manages stored per-site OAuth2
 * tokens and runs the two grant flows this CLI supports
 * (`authorization_code` via `login`, `client_credentials` via `add`). Never
 * dispatches through the generic REST command pipeline (`rest.ts`) — like
 * `wp config`, this is CLI-local bookkeeping.
 * @param parsed The parsed auth command.
 * @param flags  Global CLI flags.
 * @return The command's rendered output and exit code.
 */
export async function runOAuth2AuthCommand(
	parsed: Extract< ParsedAuth, { authType: typeof OAUTH2_AUTH_TYPE } >,
	flags: GlobalFlags
): Promise< AuthResult > {
	switch ( parsed.mode ) {
		case 'login':
			return handleLogin( parsed, flags );
		case 'add':
			return handleAdd( parsed, flags );
		case 'list':
			return handleList( flags );
		case 'remove':
			return handleRemove( parsed );
		case 'remove-all':
			return handleRemoveAll();
		case 'use':
			return handleUse( parsed );
		case 'status':
			return handleStatus();
	}
}
