/**
 * Internal dependencies
 */
import {
	APPLICATION_PASSWORDS_AUTH_TYPE,
	OAUTH2_AUTH_TYPE,
	type AuthType,
} from '../core/auth/types.js';
import { CliError } from '../core/errors.js';
import type { GlobalFlags } from '../types.js';
import { runApplicationPasswordsAuthCommand } from './auth/application-passwords.js';
import { runOAuth2AuthCommand } from './auth/oauth2.js';

const DEFAULT_APP_NAME = 'wp-rest-cli';
const AUTH_SUBCOMMANDS = [ 'login', 'add', 'list', 'remove', 'use', 'status' ];

/**
 * The single rendering of "which auth types this CLI knows about" — reused
 * everywhere that fact is shown so the wording can't drift out of sync
 * between call sites.
 */
export const AVAILABLE_AUTH_TYPES_LINE = `Available types: ${ APPLICATION_PASSWORDS_AUTH_TYPE }, ${ OAUTH2_AUTH_TYPE }.`;

export type AuthResult = { output: string; exitCode: number };

/**
 * A parsed `wp auth <type> ...` command. `login`/`add` are authType-conditional —
 * each type's own fields (`appName` for application-passwords; `redirectUri`/
 * `port` for oauth2) only exist on that type's own union member, so a
 * handler can't accidentally read a field that was never parsed for the type
 * it's handling. Credentials themselves (`--username`/`--password` for
 * application-passwords, `--client-id`/`--client-secret` for oauth2) are
 * deliberately *not* carried here — both come from the global `GlobalFlags`
 * at handler-execution time instead (see `runApplicationPasswordsAuthCommand`'s
 * `handleAdd`/`handleLogin` for the existing pattern this follows), since
 * they're real CLI-wide flags, not subcommand-scoped field tokens. The other
 * five modes carry no type-specific fields, so they stay a single member
 * each, parameterized over the full {@link AuthType} union.
 */
export type ParsedAuth =
	| {
			authType: typeof APPLICATION_PASSWORDS_AUTH_TYPE;
			mode: 'login';
			url: string;
			appName: string;
	  }
	| {
			authType: typeof OAUTH2_AUTH_TYPE;
			mode: 'login';
			url: string;
			redirectUri?: string;
			port?: number;
	  }
	| {
			authType: typeof APPLICATION_PASSWORDS_AUTH_TYPE;
			mode: 'add';
			url: string;
			skipVerify: boolean;
	  }
	| {
			authType: typeof OAUTH2_AUTH_TYPE;
			mode: 'add';
			url: string;
	  }
	| { authType: typeof APPLICATION_PASSWORDS_AUTH_TYPE; mode: 'list' }
	| { authType: typeof OAUTH2_AUTH_TYPE; mode: 'list' }
	| {
			authType: typeof APPLICATION_PASSWORDS_AUTH_TYPE;
			mode: 'remove';
			url: string;
	  }
	| { authType: typeof OAUTH2_AUTH_TYPE; mode: 'remove'; url: string }
	| {
			authType: typeof APPLICATION_PASSWORDS_AUTH_TYPE;
			mode: 'remove-all';
	  }
	| { authType: typeof OAUTH2_AUTH_TYPE; mode: 'remove-all' }
	| {
			authType: typeof APPLICATION_PASSWORDS_AUTH_TYPE;
			mode: 'use';
			url: string;
	  }
	| { authType: typeof OAUTH2_AUTH_TYPE; mode: 'use'; url: string }
	| { authType: typeof APPLICATION_PASSWORDS_AUTH_TYPE; mode: 'status' }
	| { authType: typeof OAUTH2_AUTH_TYPE; mode: 'status' };

/**
 * Validates the `<type>` token immediately following `auth` before any verb
 * parsing happens, with two distinct errors: type missing or entirely
 * unrecognized; or — specifically — a bare verb typed where the type belongs,
 * the exact mistake anyone using the old `wp auth <verb> ...` grammar (no
 * type) would make.
 * @param  type The first token after `auth`, if any.
 * @throws {CliError} Always, unless `type` is a currently-implemented {@link AuthType}.
 */
export function assertKnownAuthType(
	type: string | undefined
): asserts type is AuthType {
	if (
		type === APPLICATION_PASSWORDS_AUTH_TYPE ||
		type === OAUTH2_AUTH_TYPE
	) {
		return;
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
 * The full `wp auth <type> --help`/`wp auth --help` usage line, branched on
 * `authType` since each type's field grammar is different — a bare
 * `wp auth --help` (no type at all) falls back to the generic usage.
 * @param authType The already-validated type, if one was given.
 * @return The usage text to print.
 */
export function authUsageText( authType?: AuthType ): string {
	if ( authType === OAUTH2_AUTH_TYPE ) {
		return (
			`Usage: wp auth ${ OAUTH2_AUTH_TYPE } <login|add|list|remove|use|status> [<url>] [--client-id=] [--client-secret=] [redirect-uri=] [port=] [--all]\n` +
			`${ AVAILABLE_AUTH_TYPES_LINE }\n` +
			'login requires --client-id= (--client-secret= is optional); add requires both --client-id= and --client-secret=.'
		);
	}
	if ( authType === APPLICATION_PASSWORDS_AUTH_TYPE ) {
		return `Usage: wp auth ${ APPLICATION_PASSWORDS_AUTH_TYPE } <login|add|list|remove|use|status> [<url>] [--username=] [--password=] [--skip-verify] [--all]\n${ AVAILABLE_AUTH_TYPES_LINE }\nlogin also accepts an optional app-name=<name> field (default: wp-rest-cli).`;
	}
	return `Usage: wp auth <type> <${ AUTH_SUBCOMMANDS.join(
		'|'
	) }> ...\n${ AVAILABLE_AUTH_TYPES_LINE }`;
}

/**
 * Whether a CLI token is one of `knownFields`' `field=value` pairs, as
 * opposed to a positional argument (a site URL). Checking against a
 * known-fields allowlist — rather than just "does this token contain `='"' —
 * matters because a real site URL routinely contains its own `=`, e.g. the
 * `?rest_route=/` discovery fallback form this CLI itself documents.
 * @param token       The raw token.
 * @param knownFields The field names this subcommand actually recognizes.
 * @return Whether `token` is shaped like `<oneOfKnownFields>=<value>`.
 */
function isKnownFieldToken( token: string, knownFields: string[] ): boolean {
	const eq = token.indexOf( '=' );
	return eq !== -1 && knownFields.includes( token.slice( 0, eq ) );
}

/**
 * Resolves a `login`/`add`/`remove`/`use` command's `<url>` argument: an
 * explicit positional URL wins if the next token isn't shaped like one of
 * `knownFields`' `field=value` pairs; otherwise falls back to `defaultUrl`
 * (the global `--url` flag, or a saved default — the exact same fallback the
 * generic REST command pipeline already uses for every other command), so
 * `wp auth <type> login`/`add`/etc. don't force repeating a URL the CLI was
 * already invoked with. Never throws itself — callers decide what "no URL
 * from either source" means for their own usage message and error priority
 * (e.g. checking for the deprecated `client-id=` syntax first).
 * @param rest        The tokens following the verb (`login`/`add`/etc.).
 * @param knownFields The field names this subcommand recognizes, for
 *                    distinguishing an omitted URL from an explicit one.
 * @param defaultUrl  The resolved `--url`/saved-default fallback, if any.
 * @return The resolved URL (if any), the remaining field tokens, and whether
 *         the URL came from an explicit positional argument (as opposed to
 *         `defaultUrl`) — needed to detect e.g. `remove <url> all=true`,
 *         which is a real conflict only when the URL was actually typed.
 */
function resolveAuthUrlArgument(
	rest: string[],
	knownFields: string[],
	defaultUrl: string | undefined
): {
	url: string | undefined;
	fieldTokens: string[];
	explicitUrlGiven: boolean;
} {
	const [ first, ...restTokens ] = rest;
	const explicitUrlGiven =
		first !== undefined && ! isKnownFieldToken( first, knownFields );
	return {
		url: explicitUrlGiven ? first : defaultUrl,
		fieldTokens: explicitUrlGiven ? restTokens : rest,
		explicitUrlGiven,
	};
}

/** Appended to a usage error when `<url>` was omitted and no `--url`/saved default was available either. */
const NO_URL_HINT =
	'Pass <url> explicitly, or run with --url=<site> (or save a default via "wp config set --url=<site>").';

/**
 * Parses trailing `field=value` tokens.
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
 * Parses a `port=` field value into a positive integer.
 * @param  raw The raw `port=` field value, if given.
 * @return The parsed port, or undefined if `raw` wasn't given.
 * @throws {CliError} If `raw` was given but isn't a valid port number.
 */
function parsePortField( raw: string | undefined ): number | undefined {
	if ( raw === undefined ) {
		return undefined;
	}
	const port = Number( raw );
	if ( ! Number.isInteger( port ) || port <= 0 || port > 65535 ) {
		throw new CliError( `"port=${ raw }" is not a valid port number.` );
	}
	return port;
}

/**
 * Parses `wp auth <type> login ...`, authType-conditionally: application-passwords
 * takes an optional trailing `app-name=<name>` field; oauth2 accepts optional
 * `redirect-uri=`/`port=` fields (the actual `--client-id`/`--client-secret`
 * credential comes from global flags — see `handleLogin` in
 * `commands/auth/oauth2.ts`, and the {@link ParsedAuth} doc comment for why).
 * `<url>` is optional in both — see `resolveAuthUrlArgument`.
 * @param authType   The already-validated auth type.
 * @param rest       The tokens following `login`.
 * @param defaultUrl The resolved `--url`/saved-default fallback, if `<url>` is omitted.
 * @return The parsed `login` command.
 */
function parseLoginArgs(
	authType: AuthType,
	rest: string[],
	defaultUrl: string | undefined
): ParsedAuth {
	if ( authType === OAUTH2_AUTH_TYPE ) {
		// 'client-id'/'client-secret' included here too (not just checked
		// after resolving fieldTokens below) so `wp auth oauth2 login
		// client-id=xxx` (old syntax, no URL at all) is recognized as a field
		// token rather than misread as the site URL, and falls through to the
		// specific migration-hint rejection below instead of a confusing
		// "invalid URL" failure.
		const { url, fieldTokens } = resolveAuthUrlArgument(
			rest,
			[ 'redirect-uri', 'port', 'client-id', 'client-secret' ],
			defaultUrl
		);
		const fields = parseFields( fieldTokens );
		// `client-id=`/`client-secret=` were this type's field-token syntax
		// before it switched to real `--client-id`/`--client-secret` flags —
		// flagged explicitly rather than silently captured into `fields` and
		// never read, which would otherwise look like a successful login
		// using credentials that were actually ignored. Checked before the
		// "no URL" error below, since it's the more specific, actionable one.
		if (
			fields[ 'client-id' ] !== undefined ||
			fields[ 'client-secret' ] !== undefined
		) {
			throw new CliError(
				`wp auth ${ authType } login: client-id=/client-secret= are no longer accepted here — use --client-id=<id>/--client-secret=<secret> instead.`
			);
		}
		if ( ! url ) {
			throw new CliError(
				`Usage: wp auth ${ authType } login [<url>] --client-id=<id> [--client-secret=<secret>] [redirect-uri=<uri>] [port=<port>]\n${ NO_URL_HINT }`
			);
		}
		// `redirect-uri=` already carries a port; combining it with `port=`
		// would silently discard one of the two (whichever `handleLogin`
		// doesn't prefer) with no indication that happened, so this is
		// rejected outright rather than picking a winner quietly.
		if (
			fields[ 'redirect-uri' ] !== undefined &&
			fields.port !== undefined
		) {
			throw new CliError(
				`wp auth ${ authType } login: pass either redirect-uri= (which already includes a port) or port=, not both.`
			);
		}
		return {
			authType: OAUTH2_AUTH_TYPE,
			mode: 'login',
			url,
			redirectUri: fields[ 'redirect-uri' ],
			port: parsePortField( fields.port ),
		};
	}

	const { url, fieldTokens } = resolveAuthUrlArgument(
		rest,
		[ 'app-name' ],
		defaultUrl
	);
	if ( ! url ) {
		throw new CliError(
			`Usage: wp auth ${ authType } login [<url>] [app-name=<name>]\n${ NO_URL_HINT }`
		);
	}
	const fields = parseFields( fieldTokens );
	// `!== undefined` (not `||`): an explicit `app-name=` (empty string) is a
	// deliberate override and shouldn't be silently replaced by the default.
	return {
		authType: APPLICATION_PASSWORDS_AUTH_TYPE,
		mode: 'login',
		url,
		appName:
			fields[ 'app-name' ] !== undefined
				? fields[ 'app-name' ]
				: DEFAULT_APP_NAME,
	};
}

/**
 * Parses `wp auth <type> add ...`, authType-conditionally: application-passwords
 * takes username/password from the global `--username`/`--password` flags
 * (see `handleAdd` in `commands/auth/application-passwords.ts`) plus an
 * optional `skip-verify=true` field; oauth2 takes its client id/secret from
 * the global `--client-id`/`--client-secret` flags the same way (see
 * `handleAdd` in `commands/auth/oauth2.ts`) — `client_credentials` has no
 * browser step to obtain them from, so both are required there, checked at
 * handler-execution time once `flags` is available.
 * `<url>` is optional in both — see `resolveAuthUrlArgument`.
 * @param authType   The already-validated auth type.
 * @param rest       The tokens following `add`.
 * @param defaultUrl The resolved `--url`/saved-default fallback, if `<url>` is omitted.
 * @return The parsed `add` command.
 */
function parseAddArgs(
	authType: AuthType,
	rest: string[],
	defaultUrl: string | undefined
): ParsedAuth {
	if ( authType === OAUTH2_AUTH_TYPE ) {
		// Checked here (not just via a generic "unknown field" fallthrough)
		// so the old `client-id=`/`client-secret=` field-token syntax gets a
		// clear migration message instead of being silently parsed and
		// ignored — see the equivalent check in `parseLoginArgs`.
		const { url, fieldTokens } = resolveAuthUrlArgument(
			rest,
			[ 'client-id', 'client-secret' ],
			defaultUrl
		);
		const fields = parseFields( fieldTokens );
		if (
			fields[ 'client-id' ] !== undefined ||
			fields[ 'client-secret' ] !== undefined
		) {
			throw new CliError(
				`wp auth ${ authType } add: client-id=/client-secret= are no longer accepted here — use --client-id=<id>/--client-secret=<secret> instead.`
			);
		}
		if ( ! url ) {
			throw new CliError(
				`Usage: wp auth ${ authType } add [<url>] --client-id=<id> --client-secret=<secret>\n${ NO_URL_HINT }`
			);
		}
		return {
			authType: OAUTH2_AUTH_TYPE,
			mode: 'add',
			url,
		};
	}

	const { url, fieldTokens } = resolveAuthUrlArgument(
		rest,
		[ 'skip-verify' ],
		defaultUrl
	);
	if ( ! url ) {
		throw new CliError(
			`Usage: wp auth ${ authType } add [<url>] --username=<u> --password=<p> [--skip-verify]\n${ NO_URL_HINT }`
		);
	}
	const fields = parseFields( fieldTokens );
	return {
		authType: APPLICATION_PASSWORDS_AUTH_TYPE,
		mode: 'add',
		url,
		skipVerify: fields[ 'skip-verify' ] === 'true',
	};
}

/**
 * Parses `wp auth <type> <login|add|list|remove|use|status> ...`'s arguments
 * into a typed {@link ParsedAuth}. `<type>` is validated first (see
 * {@link assertKnownAuthType}). `<url>` is optional everywhere it appears
 * (`login`/`add`/`remove`/`use`) — see `resolveAuthUrlArgument` — falling
 * back to `defaultUrl` (the global `--url` flag, or a saved default) so a
 * command doesn't force repeating a URL the CLI was already invoked with.
 * @param args       The CLI's positional arguments following `auth`.
 * @param defaultUrl The resolved `--url`/saved-default fallback, if `<url>` is omitted.
 * @return The parsed auth command.
 */
export function parseAuthArgs(
	args: string[],
	defaultUrl?: string
): ParsedAuth {
	const [ rawType, sub, ...rest ] = args;
	assertKnownAuthType( rawType );
	const authType = rawType;
	switch ( sub ) {
		case 'login':
			return parseLoginArgs( authType, rest, defaultUrl );
		case 'add':
			return parseAddArgs( authType, rest, defaultUrl );
		case 'list':
			return { authType, mode: 'list' };
		case 'remove': {
			const { url, fieldTokens, explicitUrlGiven } =
				resolveAuthUrlArgument( rest, [ 'all' ], defaultUrl );
			const fields = parseFields( fieldTokens );
			if ( fields.all === 'true' ) {
				if ( explicitUrlGiven ) {
					throw new CliError(
						`wp auth ${ authType } remove: pass either <url> or --all, not both.`
					);
				}
				return { authType, mode: 'remove-all' };
			}
			if ( ! url ) {
				throw new CliError(
					`Usage: wp auth ${ authType } remove [<url>] | wp auth ${ authType } remove --all\n${ NO_URL_HINT }`
				);
			}
			return { authType, mode: 'remove', url };
		}
		case 'use': {
			const { url } = resolveAuthUrlArgument( rest, [], defaultUrl );
			if ( ! url ) {
				throw new CliError(
					`Usage: wp auth ${ authType } use [<url>]\n${ NO_URL_HINT }`
				);
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

/**
 * Executes a parsed `wp auth <type> ...` command, dispatching on `authType`.
 * `AuthType` is a real union, so TypeScript's exhaustiveness checking on this
 * switch forces a compile error the moment a further `AuthType` is added
 * without a matching case here — the extension point for a future auth
 * mechanism is enforced by the type system, not just a comment.
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
		case OAUTH2_AUTH_TYPE:
			return runOAuth2AuthCommand( parsed, flags );
	}
}
