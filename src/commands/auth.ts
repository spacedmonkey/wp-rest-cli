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
} from '../config.js';
import {
	introspectApplicationPassword,
	revokeApplicationPassword,
} from '../core/auth/application-passwords.js';
import {
	canSiteUseApplicationPasswords,
	runAuthorizationFlow,
} from '../core/auth/authorize.js';
import { BasicAuthProvider } from '../core/auth/basic.js';
import {
	APPLICATION_PASSWORDS_AUTH_TYPE,
	RESERVED_AUTH_TYPES,
	type AuthType,
} from '../core/auth/types.js';
import { WpRestClient } from '../core/client.js';
import { resolveApiRoot } from '../core/discovery.js';
import { CliError, WpApiError } from '../core/errors.js';
import { formatOutput } from '../core/formatter.js';
import type { GlobalFlags } from '../types.js';
import { withSpinner, pc, success, warn } from '../ui.js';

const DEFAULT_APP_NAME = 'wp-rest-cli';
const AUTH_SUBCOMMANDS = [ 'login', 'add', 'list', 'remove', 'use', 'status' ];

/**
 * The single rendering of "which auth types this CLI knows about" — reused
 * everywhere that fact is shown so the wording can't drift out of sync
 * between call sites (as it previously did between the two error branches in
 * {@link assertKnownAuthType} and the static `wp auth --help` text in `cli.ts`).
 */
export const AVAILABLE_AUTH_TYPES_LINE = `Available types: ${ APPLICATION_PASSWORDS_AUTH_TYPE }.`;

/** Text shown when re-revoking an old Application Password on the site fails or isn't possible. */
const REVOKE_MANUAL_HINT =
	' Could not revoke the previous credential on the site — you may want to remove it manually (Users → Profile → Application Passwords).';

export type ParsedAuth = { authType: AuthType } & (
	| { mode: 'login'; url: string; appName: string }
	| { mode: 'add'; url: string; skipVerify: boolean }
	| { mode: 'list' }
	| { mode: 'remove'; url: string }
	| { mode: 'remove-all' }
	| { mode: 'use'; url: string }
	| { mode: 'status' }
);

/**
 * Validates the `<type>` token immediately following `auth` before any verb
 * parsing happens, with three distinct, increasingly specific errors: type
 * missing or entirely unrecognized; recognized but not yet implemented
 * ({@link RESERVED_AUTH_TYPES}, e.g. `oauth2`); or — specifically — a bare
 * verb typed where the type belongs, the exact mistake anyone using the old
 * `wp auth <verb> ...` grammar (no type) would make.
 * @param  type The first token after `auth`, if any.
 * @throws {CliError} Always, unless `type` is a currently-implemented {@link AuthType}.
 */
export function assertKnownAuthType(
	type: string | undefined
): asserts type is AuthType {
	if ( type === APPLICATION_PASSWORDS_AUTH_TYPE ) {
		return;
	}
	if (
		type &&
		( RESERVED_AUTH_TYPES as readonly string[] ).includes( type )
	) {
		throw new CliError(
			`"${ type }" support is planned but not yet implemented. ${ AVAILABLE_AUTH_TYPES_LINE }`
		);
	}
	if ( type && AUTH_SUBCOMMANDS.includes( type ) ) {
		throw new CliError(
			`"wp auth ${ type } ..." is the old syntax — the type now comes first, e.g. "wp auth ${ APPLICATION_PASSWORDS_AUTH_TYPE } ${ type } ...".`
		);
	}
	throw new CliError(
		`Usage: wp auth <type> <${ AUTH_SUBCOMMANDS.join(
			'|'
		) }> ...\n${ AVAILABLE_AUTH_TYPES_LINE }`
	);
}

/**
 * Whether a CLI token is one of `knownFields`' `field=value` pairs, as
 * opposed to a positional argument (a site URL). Checking against a
 * known-fields allowlist — rather than just "does this token contain `='"' —
 * matters because a real site URL routinely contains its own `=`, e.g. the
 * `?rest_route=/` discovery fallback form this CLI itself documents
 * (`wp auth application-passwords login "https://example.com/?rest_route=/"`
 * must still be treated as a URL, not mistaken for a malformed field).
 * @param token       The raw token.
 * @param knownFields The field names this subcommand actually recognizes.
 * @return Whether `token` is shaped like `<oneOfKnownFields>=<value>`.
 */
function isKnownFieldToken( token: string, knownFields: string[] ): boolean {
	const eq = token.indexOf( '=' );
	return eq !== -1 && knownFields.includes( token.slice( 0, eq ) );
}

/**
 * Parses trailing `field=value` tokens (only `app-name=`, `skip-verify=`, and
 * `all=` are meaningful here, depending on the subcommand).
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
 * Parses `wp auth <type> <login|add|list|remove|use|status> ...`'s arguments
 * into a typed {@link ParsedAuth}. `<type>` is validated first (see
 * {@link assertKnownAuthType}) — today the only implemented value is
 * {@link APPLICATION_PASSWORDS_AUTH_TYPE}. Username/password for `add` come
 * from the global `--username`/`--password` flags (see {@link runAuthCommand}),
 * matching how `wp config set --username=` already works; `login` takes an
 * optional trailing `app-name=<name>` field, `add` an optional
 * `skip-verify=true`, and `remove` an optional `all=true` (in place of a
 * `<url>`) for bulk removal.
 * @param args The CLI's positional arguments following `auth`.
 * @return The parsed auth command.
 */
export function parseAuthArgs( args: string[] ): ParsedAuth {
	const [ rawType, sub, ...rest ] = args;
	assertKnownAuthType( rawType );
	const authType = rawType;
	switch ( sub ) {
		case 'login': {
			const [ url, ...fieldTokens ] = rest;
			if ( ! url || isKnownFieldToken( url, [ 'app-name' ] ) ) {
				throw new CliError(
					`Usage: wp auth ${ authType } login <url> [app-name=<name>]`
				);
			}
			const fields = parseFields( fieldTokens );
			// `!== undefined` (not `||`): an explicit `app-name=` (empty
			// string) is a deliberate override and shouldn't be silently
			// replaced by the default, however unlikely a real reason to
			// pass one is.
			return {
				authType,
				mode: 'login',
				url,
				appName:
					fields[ 'app-name' ] !== undefined
						? fields[ 'app-name' ]
						: DEFAULT_APP_NAME,
			};
		}
		case 'add': {
			const [ url, ...fieldTokens ] = rest;
			if ( ! url || isKnownFieldToken( url, [ 'skip-verify' ] ) ) {
				throw new CliError(
					`Usage: wp auth ${ authType } add <url> --username=<u> --password=<p> [--skip-verify]`
				);
			}
			const fields = parseFields( fieldTokens );
			return {
				authType,
				mode: 'add',
				url,
				skipVerify: fields[ 'skip-verify' ] === 'true',
			};
		}
		case 'list':
			return { authType, mode: 'list' };
		case 'remove': {
			const [ first, ...restTokens ] = rest;
			if ( first && isKnownFieldToken( first, [ 'all' ] ) ) {
				const fields = parseFields( [ first, ...restTokens ] );
				if ( fields.all === 'true' ) {
					return { authType, mode: 'remove-all' };
				}
				throw new CliError(
					`Usage: wp auth ${ authType } remove <url> | wp auth ${ authType } remove --all`
				);
			}
			if ( ! first ) {
				throw new CliError(
					`Usage: wp auth ${ authType } remove <url> | wp auth ${ authType } remove --all`
				);
			}
			const fields = parseFields( restTokens );
			if ( fields.all === 'true' ) {
				throw new CliError(
					`wp auth ${ authType } remove: pass either <url> or --all, not both.`
				);
			}
			return { authType, mode: 'remove', url: first };
		}
		case 'use': {
			const [ url ] = rest;
			if ( ! url ) {
				throw new CliError( `Usage: wp auth ${ authType } use <url>` );
			}
			return { authType, mode: 'use', url };
		}
		case 'status':
			return { authType, mode: 'status' };
		default:
			throw new CliError(
				`Usage: wp auth ${ authType } <${ AUTH_SUBCOMMANDS.join(
					'|'
				) }> ...`
			);
	}
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
 * skipped because the
 * site can't possibly support Application Passwords, or the credential
 * genuinely isn't one). A 200 and a 401/403 are both conclusive; anything
 * else is ambiguous and only produces a warning, never a hard failure.
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

type AuthResult = { output: string; exitCode: number };

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
	parsed: Extract< ParsedAuth, { mode: 'login' } >,
	flags: GlobalFlags
): Promise< AuthResult > {
	const previous = getSiteCredential( parsed.url );

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

	setSiteCredential( parsed.url, {
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
 * The trailing note `handleLogin` appends to its success message describing
 * what happened to the credential it's replacing, if any.
 * @param previous The credential this login is replacing, if one was stored.
 * @param apiRoot  The (already-resolved) API root for this same site — reused
 *                 rather than re-running discovery a second time.
 * @param flags    Global CLI flags.
 * @return The note text (empty if there was nothing to replace).
 */
async function revokePreviousLoginCredential(
	previous: ReturnType< typeof getSiteCredential >,
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
 * `wp auth application-passwords add <url> --username= --password= [--skip-verify]`: stores a
 * manually-supplied credential, verifying it against the site first unless
 * `--skip-verify` was passed.
 * @param parsed The parsed `add` command.
 * @param flags  Global CLI flags.
 * @return The command's rendered output and exit code.
 */
async function handleAdd(
	parsed: Extract< ParsedAuth, { mode: 'add' } >,
	flags: GlobalFlags
): Promise< AuthResult > {
	if ( ! flags.username || ! flags.password ) {
		throw new CliError(
			`wp auth ${ APPLICATION_PASSWORDS_AUTH_TYPE } add requires --username and --password.`
		);
	}

	if ( parsed.skipVerify ) {
		setSiteCredential( parsed.url, {
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

	setSiteCredential( parsed.url, {
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
	const sites = listSiteCredentials();
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
	const previous = getSiteCredential( parsed.url );
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

	removeSiteCredential( parsed.url );

	return { output: success( message ), exitCode: 0 };
}

/**
 * `wp auth application-passwords remove --all`: best-effort revokes and forgets every stored
 * credential, one site at a time — an incident-response escape hatch, so
 * intentionally sequential rather than parallelized.
 * @param flags Global CLI flags.
 * @return The command's rendered output and exit code.
 */
async function handleRemoveAll( flags: GlobalFlags ): Promise< AuthResult > {
	const sites = listSiteCredentials();
	if ( ! sites.length ) {
		return {
			output: pc.dim( 'No stored credentials to remove.' ),
			exitCode: 0,
		};
	}

	let revokedCount = 0;
	let notRevokedCount = 0;

	for ( const site of sites ) {
		const stored = getSiteCredential( site.url );
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
		removeSiteCredential( site.url );
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
	const credential = getSiteCredential( defaultUrl );
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
async function runApplicationPasswordsAuthCommand(
	parsed: ParsedAuth,
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

/**
 * Executes a parsed `wp auth <type> ...` command, dispatching on `authType`.
 * `AuthType` is a real (if currently single-member) union, so TypeScript's
 * exhaustiveness checking on this switch forces a compile error the moment a
 * second `AuthType` (e.g. `oauth2`) is added without a matching case here —
 * the extension point for a future auth mechanism is enforced by the type
 * system, not just a comment.
 * @param parsed The parsed auth command.
 * @param flags  Global CLI flags.
 * @return The command's rendered output and exit code.
 */
export async function runAuthCommand(
	parsed: ParsedAuth,
	flags: GlobalFlags
): Promise< AuthResult > {
	switch ( parsed.authType ) {
		case APPLICATION_PASSWORDS_AUTH_TYPE:
			return runApplicationPasswordsAuthCommand( parsed, flags );
	}
}
