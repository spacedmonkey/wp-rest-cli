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
 * each type's own fields (`appName` for application-passwords; `clientId`/
 * `clientSecret`/`redirectUri`/`port` for oauth2) only exist on that type's
 * own union member, so a handler can't accidentally read a field that was
 * never parsed for the type it's handling. The other five modes carry no
 * type-specific fields, so they stay a single member each, parameterized
 * over the full {@link AuthType} union.
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
			clientId: string;
			clientSecret?: string;
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
			clientId: string;
			clientSecret: string;
			// TEMPORARY, diagnostic-only: lets `wp auth oauth2 add` send an
			// arbitrary `code=` body param alongside `grant_type=client_credentials`,
			// to help confirm server-side whether a live site's deployed
			// WP-API/OAuth2 code actually special-cases client_credentials
			// before its generic "missing client_id/code" validation runs.
			// Not a real part of the client_credentials grant (it has no
			// code to exchange) — revert this once diagnosis is done.
			diagnosticCode?: string;
			// TEMPORARY, diagnostic-only: overrides the `grant_type` value
			// this request sends (normally hardcoded to `client_credentials`)
			// — lets a live-site test isolate whether the value itself, as
			// received server-side, is really what's causing the mismatch
			// (e.g. re-sending the exact same literal value to rule out any
			// transport-level corruption). Revert this once diagnosis is done.
			diagnosticGrantType?: string;
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
			`Usage: wp auth ${ OAUTH2_AUTH_TYPE } <login|add|list|remove|use|status> [<url>] [client-id=] [client-secret=] [redirect-uri=] [port=] [--all]\n` +
			`${ AVAILABLE_AUTH_TYPES_LINE }\n` +
			'login requires client-id= (client-secret= is optional); add requires both client-id= and client-secret=.'
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
 * takes an optional trailing `app-name=<name>` field; oauth2 requires a
 * `client-id=<id>` field (from a manually-created wp-admin Application) and
 * accepts optional `client-secret=`/`redirect-uri=`/`port=` fields.
 * @param authType The already-validated auth type.
 * @param rest     The tokens following `login`.
 * @return The parsed `login` command.
 */
function parseLoginArgs( authType: AuthType, rest: string[] ): ParsedAuth {
	if ( authType === OAUTH2_AUTH_TYPE ) {
		const knownFields = [
			'client-id',
			'client-secret',
			'redirect-uri',
			'port',
		];
		const [ url, ...fieldTokens ] = rest;
		if ( ! url || isKnownFieldToken( url, knownFields ) ) {
			throw new CliError(
				`Usage: wp auth ${ authType } login <url> client-id=<id> [client-secret=<secret>] [redirect-uri=<uri>] [port=<port>]`
			);
		}
		const fields = parseFields( fieldTokens );
		if ( ! fields[ 'client-id' ] ) {
			throw new CliError(
				`wp auth ${ authType } login requires a client-id=<id> field, from a manually-created wp-admin Application (Users → Applications).`
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
			clientId: fields[ 'client-id' ],
			clientSecret: fields[ 'client-secret' ],
			redirectUri: fields[ 'redirect-uri' ],
			port: parsePortField( fields.port ),
		};
	}

	const [ url, ...fieldTokens ] = rest;
	if ( ! url || isKnownFieldToken( url, [ 'app-name' ] ) ) {
		throw new CliError(
			`Usage: wp auth ${ authType } login <url> [app-name=<name>]`
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
 * (see `runAuthCommand`) plus an optional `skip-verify=true` field; oauth2
 * requires both `client-id=<id>` and `client-secret=<secret>` fields, since
 * `client_credentials` has no browser step to obtain them from.
 * @param authType The already-validated auth type.
 * @param rest     The tokens following `add`.
 * @return The parsed `add` command.
 */
function parseAddArgs( authType: AuthType, rest: string[] ): ParsedAuth {
	if ( authType === OAUTH2_AUTH_TYPE ) {
		const knownFields = [
			'client-id',
			'client-secret',
			'code',
			'grant-type',
		];
		const [ url, ...fieldTokens ] = rest;
		if ( ! url || isKnownFieldToken( url, knownFields ) ) {
			throw new CliError(
				`Usage: wp auth ${ authType } add <url> client-id=<id> client-secret=<secret>`
			);
		}
		const fields = parseFields( fieldTokens );
		if ( ! fields[ 'client-id' ] || ! fields[ 'client-secret' ] ) {
			throw new CliError(
				`wp auth ${ authType } add requires both client-id=<id> and client-secret=<secret>, from a manually-created wp-admin Application with the client_credentials grant enabled.`
			);
		}
		return {
			authType: OAUTH2_AUTH_TYPE,
			mode: 'add',
			url,
			clientId: fields[ 'client-id' ],
			clientSecret: fields[ 'client-secret' ],
			diagnosticCode: fields.code,
			diagnosticGrantType: fields[ 'grant-type' ],
		};
	}

	const [ url, ...fieldTokens ] = rest;
	if ( ! url || isKnownFieldToken( url, [ 'skip-verify' ] ) ) {
		throw new CliError(
			`Usage: wp auth ${ authType } add <url> --username=<u> --password=<p> [--skip-verify]`
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
 * {@link assertKnownAuthType}).
 * @param args The CLI's positional arguments following `auth`.
 * @return The parsed auth command.
 */
export function parseAuthArgs( args: string[] ): ParsedAuth {
	const [ rawType, sub, ...rest ] = args;
	assertKnownAuthType( rawType );
	const authType = rawType;
	switch ( sub ) {
		case 'login':
			return parseLoginArgs( authType, rest );
		case 'add':
			return parseAddArgs( authType, rest );
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
