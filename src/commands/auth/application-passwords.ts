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
	type StoredApplicationPasswordCredential,
} from '../../config.js';
import {
	introspectApplicationPassword,
	revokeApplicationPassword,
} from '../../core/auth/application-passwords.js';
import {
	canSiteUseApplicationPasswords,
	runAuthorizationFlow,
} from '../../core/auth/authorize.js';
import { BasicAuthProvider } from '../../core/auth/basic.js';
import { APPLICATION_PASSWORDS_AUTH_TYPE } from '../../core/auth/types.js';
import { WpRestClient } from '../../core/client.js';
import { resolveApiRoot } from '../../core/discovery.js';
import { CliError, WpApiError } from '../../core/errors.js';
import { formatOutput } from '../../core/formatter.js';
import type { GlobalFlags } from '../../types.js';
import { withSpinner, pc, success, warn } from '../../ui.js';
import type { AuthResult, ParsedAuth } from '../auth.js';

/** Text shown when re-revoking an old Application Password on the site fails or isn't possible. */
const REVOKE_MANUAL_HINT =
	' Could not revoke the previous credential on the site — you may want to remove it manually (Users → Profile → Application Passwords).';

/**
 * Narrows a {@link SiteCredentialRow} to its application-passwords member —
 * `listSiteCredentials()` returns rows for every stored auth type, and each
 * type's own handlers filter to their own rows client-side.
 * @param site A row from `listSiteCredentials()`.
 * @return Whether `site` is an application-passwords row.
 */
function isApplicationPasswordsRow(
	site: SiteCredentialRow
): site is Extract<
	SiteCredentialRow,
	{ authType: typeof APPLICATION_PASSWORDS_AUTH_TYPE }
> {
	return site.authType === APPLICATION_PASSWORDS_AUTH_TYPE;
}

/** The outcome of verifying a manually-supplied credential for `wp auth application-passwords add`. */
interface AddVerificationResult {
	authMethod: 'password' | 'application-password';
	uuid?: string;
	/** Appended to the success message, e.g. explaining *why* this could only be a plain password. */
	note?: string;
	/** Set when verification was inconclusive (network error, unexpected status, etc.) — the credential is still saved, but a warning is shown. */
	warning?: string;
}

/**
 * The generic "am I authenticated at all" check `wp auth application-passwords
 * add`'s validation falls back to when introspection doesn't apply (either
 * skipped because the site can't possibly support Application Passwords, or
 * the credential genuinely isn't one). A 200 and a 401/403 are both
 * conclusive; anything else is ambiguous and only produces a warning, never a
 * hard failure.
 * @param client  The REST client, already carrying the credential to verify.
 * @param apiRoot The resolved REST API root.
 * @return The verification outcome — always `authMethod: 'password'`.
 */
async function verifyViaUsersMe(
	client: WpRestClient,
	apiRoot: string
): Promise< AddVerificationResult > {
	try {
		await client.request( new URL( 'wp/v2/users/me', apiRoot ).toString(), {
			timeoutMs: 8000,
		} );
		return { authMethod: 'password' };
	} catch ( error ) {
		if (
			error instanceof WpApiError &&
			( error.status === 401 || error.status === 403 )
		) {
			throw new CliError(
				'These credentials were rejected by the site — pass --skip-verify to save anyway.'
			);
		}
		return {
			authMethod: 'password',
			warning:
				'Could not verify these credentials against the site (network error, or an unexpected response) — saving anyway.',
		};
	}
}

/**
 * Verifies a manually-supplied `wp auth application-passwords add` credential
 * against the live site: tries to confirm it's an Application Password first (conclusive,
 * either way), then falls back to a generic authenticated check. Never
 * called when `--skip-verify` is passed.
 * @param apiRoot  The resolved REST API root.
 * @param username The username to verify.
 * @param password The password (or Application Password) to verify.
 * @param debug    Whether to log request/response diagnostics.
 * @return The verification outcome — throws a {@link CliError} only when the
 *         credentials were conclusively rejected (401/403).
 */
async function verifyAddCredential(
	apiRoot: string,
	username: string,
	password: string,
	debug: boolean
): Promise< AddVerificationResult > {
	const client = new WpRestClient(
		new BasicAuthProvider( username, password ),
		debug
	);
	const canUseAppPasswords = canSiteUseApplicationPasswords( apiRoot );

	if ( canUseAppPasswords ) {
		const introspected = await introspectApplicationPassword(
			client,
			apiRoot
		);
		if ( introspected ) {
			return {
				authMethod: 'application-password',
				uuid: introspected.uuid,
			};
		}
	}

	const usersMeResult = await verifyViaUsersMe( client, apiRoot );
	if ( ! canUseAppPasswords && ! usersMeResult.warning ) {
		return {
			...usersMeResult,
			note: ' (Application Passwords require HTTPS — except on localhost — so this could only be a regular account password here.)',
		};
	}
	return usersMeResult;
}

/**
 * Best-effort revokes a stored Application Password on its site. Every
 * possible failure (an unreachable site, a rejected request, the password
 * already gone) is swallowed — this must never block a local `remove`.
 * @param site          The stored credential's username/password/uuid.
 * @param site.username The credential's username.
 * @param site.password The credential's password (an Application Password).
 * @param site.uuid     The Application Password's uuid on the site.
 * @param url           The site URL the credential belongs to.
 * @param debug         Whether to log request/response diagnostics.
 * @return Whether the credential was actually revoked on the site.
 */
async function tryRevokeStoredCredential(
	site: { username: string; password: string; uuid: string },
	url: string,
	debug: boolean
): Promise< boolean > {
	try {
		const apiRoot = await resolveApiRoot( url, debug );
		const client = new WpRestClient(
			new BasicAuthProvider( site.username, site.password ),
			debug
		);
		return await revokeApplicationPassword( client, apiRoot, site.uuid );
	} catch {
		return false;
	}
}

/**
 * The trailing note `handleLogin` appends to its success message describing
 * what happened to the credential it's replacing, if any.
 * @param previous The credential this login is replacing, if one was stored.
 * @param apiRoot  The (already-resolved) API root for this same site — reused
 *                 rather than re-running discovery a second time.
 * @param flags    Global CLI flags.
 * @return The note text (empty if there was nothing to replace).
 */
async function revokePreviousLoginCredential(
	previous: StoredApplicationPasswordCredential | undefined,
	apiRoot: string,
	flags: GlobalFlags
): Promise< string > {
	if ( ! previous ) {
		return '';
	}
	if ( previous.authMethod !== 'application-password' || ! previous.uuid ) {
		return ' (An existing stored credential is being replaced; it was not tracked for automatic revocation.)';
	}
	const previousClient = new WpRestClient(
		new BasicAuthProvider( previous.username, previous.password ),
		flags.debug
	);
	const revoked = await revokeApplicationPassword(
		previousClient,
		apiRoot,
		previous.uuid
	);
	return revoked
		? ' Revoked the previous stored credential on the site.'
		: REVOKE_MANUAL_HINT;
}

/**
 * `wp auth application-passwords login <url>`: runs the browser-based registration flow, then
 * best-effort revokes whatever Application Password it's replacing for this
 * site. Ordering matters — the new credential is always safely stored
 * *before* anything old is touched, so a mid-flow failure can never destroy
 * the old credential without having stored the new one.
 * @param parsed The parsed `login` command.
 * @param flags  Global CLI flags.
 * @return The command's rendered output and exit code.
 */
async function handleLogin(
	parsed: Extract<
		ParsedAuth,
		{ mode: 'login'; authType: typeof APPLICATION_PASSWORDS_AUTH_TYPE }
	>,
	flags: GlobalFlags
): Promise< AuthResult > {
	const previous = getSiteCredential(
		parsed.url,
		APPLICATION_PASSWORDS_AUTH_TYPE
	);

	const apiRoot = await withSpinner(
		'Discovering REST API',
		! flags.quiet,
		() => resolveApiRoot( parsed.url, flags.debug )
	);
	const client = new WpRestClient( undefined, flags.debug );
	const { userLogin, password } = await runAuthorizationFlow(
		client,
		apiRoot,
		parsed.appName
	);

	const newClient = new WpRestClient(
		new BasicAuthProvider( userLogin, password ),
		flags.debug
	);
	const introspected = await introspectApplicationPassword(
		newClient,
		apiRoot
	);

	setSiteCredential( parsed.url, APPLICATION_PASSWORDS_AUTH_TYPE, {
		username: userLogin,
		password,
		authMethod: 'application-password',
		uuid: introspected?.uuid,
	} );

	const note = await revokePreviousLoginCredential(
		previous,
		apiRoot,
		flags
	);

	return {
		output: success(
			`Saved an Application Password for ${ userLogin }@${ normalizeSiteUrl(
				parsed.url
			) }.${ note }`
		),
		exitCode: 0,
	};
}

/**
 * `wp auth application-passwords add <url> --username= --password= [--skip-verify]`: stores a
 * manually-supplied credential, verifying it against the site first unless
 * `--skip-verify` was passed.
 * @param parsed The parsed `add` command.
 * @param flags  Global CLI flags.
 * @return The command's rendered output and exit code.
 */
async function handleAdd(
	parsed: Extract<
		ParsedAuth,
		{ mode: 'add'; authType: typeof APPLICATION_PASSWORDS_AUTH_TYPE }
	>,
	flags: GlobalFlags
): Promise< AuthResult > {
	if ( ! flags.username || ! flags.password ) {
		throw new CliError(
			`wp auth ${ APPLICATION_PASSWORDS_AUTH_TYPE } add requires --username and --password.`
		);
	}

	if ( parsed.skipVerify ) {
		setSiteCredential( parsed.url, APPLICATION_PASSWORDS_AUTH_TYPE, {
			username: flags.username,
			password: flags.password,
			authMethod: 'password',
		} );
		return {
			output: success(
				`Saved credentials for ${ flags.username }@${ normalizeSiteUrl(
					parsed.url
				) }.`
			),
			exitCode: 0,
		};
	}

	const apiRoot = await withSpinner(
		'Discovering REST API',
		! flags.quiet,
		() => resolveApiRoot( parsed.url, flags.debug )
	);
	const verification = await verifyAddCredential(
		apiRoot,
		flags.username,
		flags.password,
		flags.debug
	);

	setSiteCredential( parsed.url, APPLICATION_PASSWORDS_AUTH_TYPE, {
		username: flags.username,
		password: flags.password,
		authMethod: verification.authMethod,
		uuid: verification.uuid,
	} );

	const successLine = success(
		`Saved credentials for ${ flags.username }@${ normalizeSiteUrl(
			parsed.url
		) }.${ verification.note ?? '' }`
	);
	const output = verification.warning
		? `${ warn( verification.warning ) }\n${ successLine }`
		: successLine;

	return { output, exitCode: 0 };
}

/**
 * `wp auth application-passwords list`: every stored site's URL/username/auth method, never passwords.
 * @param flags Global CLI flags.
 * @return The command's rendered output and exit code.
 */
async function handleList( flags: GlobalFlags ): Promise< AuthResult > {
	const sites = listSiteCredentials().filter( isApplicationPasswordsRow );
	if ( ! sites.length ) {
		return {
			output: pc.dim(
				`No stored credentials. Use "wp auth ${ APPLICATION_PASSWORDS_AUTH_TYPE } login <url>" or "wp auth ${ APPLICATION_PASSWORDS_AUTH_TYPE } add <url> --username=<u> --password=<p>".`
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
		username: site.username,
		authMethod: site.authMethod,
		default: site.url === normalizedDefault ? '*' : '',
	} ) );
	const output = await formatOutput( rows, {
		format: flags.format,
		fields: flags.fields,
		field: flags.field,
		color: flags.color,
		truncate: false,
	} );
	return { output, exitCode: 0 };
}

/**
 * `wp auth application-passwords remove <url>`: forgets the stored credential locally, first
 * best-effort revoking it on the site if it's a tracked Application Password.
 * @param parsed The parsed `remove` command.
 * @param flags  Global CLI flags.
 * @return The command's rendered output and exit code.
 */
async function handleRemove(
	parsed: Extract< ParsedAuth, { mode: 'remove' } >,
	flags: GlobalFlags
): Promise< AuthResult > {
	const previous = getSiteCredential(
		parsed.url,
		APPLICATION_PASSWORDS_AUTH_TYPE
	);
	if ( ! previous ) {
		throw new CliError(
			`No stored credential for ${ normalizeSiteUrl( parsed.url ) }.`
		);
	}

	const site = normalizeSiteUrl( parsed.url );
	let message = `Removed stored credential for ${ site }.`;
	if ( previous.authMethod === 'application-password' && previous.uuid ) {
		const revoked = await tryRevokeStoredCredential(
			{
				username: previous.username,
				password: previous.password,
				uuid: previous.uuid,
			},
			parsed.url,
			flags.debug
		);
		message = revoked
			? `Removed stored credential for ${ site }, and revoked it on the site.`
			: `Removed stored credential for ${ site } locally — could not revoke it on the site (it may already be gone, or the site is unreachable).`;
	}

	removeSiteCredential( parsed.url, APPLICATION_PASSWORDS_AUTH_TYPE );

	return { output: success( message ), exitCode: 0 };
}

/**
 * `wp auth application-passwords remove --all`: best-effort revokes and
 * forgets every stored application-passwords credential, one site at a
 * time — an incident-response escape hatch, so intentionally sequential
 * rather than parallelized. Scoped to this auth type only: a site's stored
 * oauth2 credential (if any) is left untouched.
 * @param flags Global CLI flags.
 * @return The command's rendered output and exit code.
 */
async function handleRemoveAll( flags: GlobalFlags ): Promise< AuthResult > {
	const sites = listSiteCredentials().filter( isApplicationPasswordsRow );
	if ( ! sites.length ) {
		return {
			output: pc.dim( 'No stored credentials to remove.' ),
			exitCode: 0,
		};
	}

	let revokedCount = 0;
	let notRevokedCount = 0;

	for ( const site of sites ) {
		const stored = getSiteCredential(
			site.url,
			APPLICATION_PASSWORDS_AUTH_TYPE
		);
		if ( stored?.authMethod === 'application-password' && stored.uuid ) {
			const revoked = await tryRevokeStoredCredential(
				{
					username: stored.username,
					password: stored.password,
					uuid: stored.uuid,
				},
				site.url,
				flags.debug
			);
			if ( revoked ) {
				revokedCount++;
			} else {
				notRevokedCount++;
			}
		}
		removeSiteCredential( site.url, APPLICATION_PASSWORDS_AUTH_TYPE );
	}

	const attempted = revokedCount + notRevokedCount;
	const summary =
		`removed ${ sites.length } stored credential(s)` +
		( attempted > 0
			? ` (revoked ${ revokedCount } on their sites; ${ notRevokedCount } could not be revoked remotely)`
			: '' );

	return { output: success( summary ), exitCode: 0 };
}

/**
 * `wp auth application-passwords use <url>`: sets the default `--url` (same mechanism `wp config
 * set --url=` uses).
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
 * `wp auth application-passwords status`: the current default site, and whether a credential is stored for it.
 * @return The command's rendered output and exit code.
 */
function handleStatus(): AuthResult {
	const defaultUrl = getDefaultUrl();
	if ( ! defaultUrl ) {
		return {
			output: pc.dim(
				`No default site set. Use "wp auth ${ APPLICATION_PASSWORDS_AUTH_TYPE } use <url>" or "wp config set --url=<url>".`
			),
			exitCode: 0,
		};
	}
	const credential = getSiteCredential(
		defaultUrl,
		APPLICATION_PASSWORDS_AUTH_TYPE
	);
	const lines = [
		`default site: ${ defaultUrl }`,
		credential
			? pc.green(
					`authenticated as ${ credential.username } (${ credential.authMethod })`
			  )
			: pc.dim(
					`no stored credential for this site — pass --username/--password (or WP_USERNAME/WP_PASSWORD), or run "wp auth ${ APPLICATION_PASSWORDS_AUTH_TYPE } login <url>".`
			  ),
	];
	return { output: lines.join( '\n' ), exitCode: 0 };
}

/**
 * Executes a parsed `wp auth application-passwords` command: manages stored
 * per-site credentials and runs the browser-based Application Password
 * registration flow. Never dispatches through the generic REST command
 * pipeline (`rest.ts`) — like `wp config`, this is CLI-local bookkeeping.
 * @param parsed The parsed auth command.
 * @param flags  Global CLI flags (only `--username`/`--password`/`--format`/`--fields`/`--field`/`--color`/`--quiet`/`--debug` are relevant here).
 * @return The command's rendered output and exit code.
 */
export async function runApplicationPasswordsAuthCommand(
	parsed: Extract<
		ParsedAuth,
		{ authType: typeof APPLICATION_PASSWORDS_AUTH_TYPE }
	>,
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
			return handleRemove( parsed, flags );
		case 'remove-all':
			return handleRemoveAll( flags );
		case 'use':
			return handleUse( parsed );
		case 'status':
			return handleStatus();
	}
}
