/**
 * External dependencies
 */
import { Command } from 'commander';
import process from 'node:process';

/**
 * Internal dependencies
 */
import {
	assertKnownAuthType,
	authUsageText,
	parseAuthArgs,
	runAuthCommand,
} from './commands/auth.js';
import {
	parseCommandArgs,
	runRestCommand,
	parseHelpArgs,
	runHelpCommand,
	type HelpStyle,
} from './commands/rest.js';
import {
	getDefaultUrl,
	getDefaultUsername,
	setDefaults,
	clearDefaults,
	configFilePath,
	rotateEncryptionKey,
} from './config.js';
import {
	APPLICATION_PASSWORDS_AUTH_TYPE,
	OAUTH2_AUTH_TYPE,
	type AuthType,
} from './core/auth/types.js';
import { debugLog } from './core/debug.js';
import {
	formatErrorForDisplay,
	formatErrorForJson,
	CliError,
	WpApiError,
} from './core/errors.js';
import {
	getFileConfig,
	type FileConfigKey,
	loadFileConfig,
	userConfigPath,
} from './core/file-config.js';
import { setTruncateEnabled } from './core/formatter.js';
import { setUserTimeout } from './core/timeout.js';
import { disableTlsVerification } from './core/tls.js';
import type {
	AuthSource,
	Context,
	GlobalFlags,
	OutputFormat,
} from './types.js';
import {
	agentMode,
	agentModeReason,
	colorByDefault,
	pc,
	setColorEnabled,
} from './ui.js';

const CONTEXTS: Context[] = [ 'view', 'edit', 'embed' ];
const FORMATS: OutputFormat[] = [
	'table',
	'json',
	'csv',
	'yaml',
	'ids',
	'count',
	'raw',
];
const AUTH_SOURCES: AuthSource[] = [
	'env',
	'none',
	APPLICATION_PASSWORDS_AUTH_TYPE,
	OAUTH2_AUTH_TYPE,
];

// Long-option names commander owns directly. Everything else that looks like
// --name=value or a bare --flag is a dynamic WP REST API field/query arg
// (e.g. --per_page=5, --title="Hello", --force) whose name isn't known ahead
// of time, so it's rewritten to the bare `name=value` form the dynamic
// namespace/route/verb parser already understands, and passed through as a
// positional argument instead of being rejected as an unknown option.
const KNOWN_LONG_FLAGS = new Set( [
	'url',
	'username',
	'password',
	'client-id',
	'client-secret',
	'token',
	'use-auth',
	'context',
	'format',
	'fields',
	'field',
	'body',
	'timeout',
	'color',
	'no-color',
	'truncate',
	'no-truncate',
	'quiet',
	'debug',
	'help',
] );

/**
 * Renders an error for stderr: JSON in agent mode or under `--format=json`
 * (even if that `--format` value is what failed validation), else plain text.
 * @param error  The caught value, of any shape.
 * @param format The raw `--format` option, if given.
 * @return The text to print.
 */
function errorText( error: unknown, format: string | undefined ): string {
	return agentMode() || format === 'json'
		? formatErrorForJson( error )
		: formatErrorForDisplay( error );
}

/**
 * Rewrites any `--name=value`/`--flag` not in {@link KNOWN_LONG_FLAGS} into a
 * bare `name=value`/`name=true` positional token, so Commander doesn't reject
 * dynamic WordPress field/query args as unknown options.
 * @param argv The raw `process.argv`-style argument list.
 * @return The rewritten argument list.
 */
function normalizeDynamicFlags( argv: string[] ): string[] {
	return argv.map( ( token ) => {
		const withValue = token.match( /^--([a-zA-Z0-9_-]+)=([\s\S]*)$/ );
		if ( withValue ) {
			const [ , name, value ] = withValue;
			return KNOWN_LONG_FLAGS.has( name as string )
				? token
				: `${ name }=${ value }`;
		}
		const boolFlag = token.match( /^--([a-zA-Z0-9_-]+)$/ );
		if ( boolFlag ) {
			const [ , name ] = boolFlag;
			return KNOWN_LONG_FLAGS.has( name as string )
				? token
				: `${ name }=true`;
		}
		return token;
	} );
}

/**
 * Parses the `--timeout` value into milliseconds.
 * @param value The raw option value, if given.
 * @return The timeout in milliseconds, or undefined when not given.
 */
function parseTimeout( value: string | undefined ): number | undefined {
	if ( value === undefined ) {
		return undefined;
	}
	const ms = Number( value );
	if ( ! Number.isInteger( ms ) || ms <= 0 ) {
		throw new CliError(
			`--timeout must be a positive number of milliseconds (got "${ value }").`
		);
	}
	return ms;
}

interface RawOptions {
	url?: string;
	username?: string;
	password?: string;
	clientId?: string;
	clientSecret?: string;
	token?: string;
	useAuth?: string;
	context: string;
	format: string;
	fields?: string;
	field?: string;
	body?: string;
	timeout?: string;
	color: boolean;
	truncate: boolean;
	quiet?: boolean;
	debug?: boolean;
	help?: boolean;
}

/**
 * Fills in any global flag the user didn't pass from the config files, so
 * `toGlobalFlags` validates file values exactly like command-line ones. A flag
 * counts as "not passed" when Commander's value source is its built-in default
 * (or it has none) — that's how `--format=table` still beats a file's `format`.
 * @param options Commander's raw parsed options.
 * @return The options with file values applied where the flag wasn't passed.
 */
function applyFileConfig( options: RawOptions ): RawOptions {
	const { values, files } = loadFileConfig();
	if ( options.debug || values.debug ) {
		debugLog( `config files: ${ files.join( ', ' ) || '(none)' }` );
		const reason = agentModeReason();
		debugLog( `agent mode: ${ reason ? `on (${ reason })` : 'off' }` );
	}
	const passed = ( name: string ) => {
		const source = program.getOptionValueSource( name );
		return source !== undefined && source !== 'default';
	};
	const merged = { ...options };
	const set = ( name: keyof RawOptions, value: unknown ) => {
		if ( value !== undefined && ! passed( name ) ) {
			( merged as Record< string, unknown > )[ name ] = value;
		}
	};
	set( 'context', values.context );
	set( 'format', values.format ?? ( agentMode() ? 'json' : undefined ) );
	set( 'useAuth', values[ 'use-auth' ] );
	set( 'timeout', values.timeout?.toString() );
	set( 'color', values.color );
	set( 'quiet', values.quiet );
	set( 'debug', values.debug );
	return merged;
}

/**
 * Validates and narrows Commander's raw parsed options into typed {@link GlobalFlags}.
 * Color is on unless `--no-color`, `NO_COLOR` or agent mode (`WRAPIDO_AGENT`) turns it off.
 * @param options Commander's raw parsed options.
 * @return The validated global flags.
 */
function toGlobalFlags( options: RawOptions ): GlobalFlags {
	const timeout = parseTimeout( options.timeout );
	if ( ! CONTEXTS.includes( options.context as Context ) ) {
		throw new CliError(
			`--context must be one of: ${ CONTEXTS.join( ', ' ) } (got "${
				options.context
			}").`
		);
	}
	if ( ! FORMATS.includes( options.format as OutputFormat ) ) {
		throw new CliError(
			`--format must be one of: ${ FORMATS.join( ', ' ) } (got "${
				options.format
			}").`
		);
	}
	if (
		options.useAuth !== undefined &&
		! AUTH_SOURCES.includes( options.useAuth as AuthSource )
	) {
		throw new CliError(
			`--use-auth must be one of: ${ AUTH_SOURCES.join( ', ' ) } (got "${
				options.useAuth
			}").`
		);
	}
	// Every HTTP request this process makes honours --timeout.
	setUserTimeout( timeout );
	return {
		url: options.url,
		username: options.username,
		password: options.password,
		clientId: options.clientId,
		clientSecret: options.clientSecret,
		token: options.token,
		useAuth: options.useAuth as AuthSource | undefined,
		context: options.context as Context,
		format: options.format as OutputFormat,
		fields: options.fields,
		field: options.field,
		body: options.body,
		timeout,
		color: options.color && colorByDefault(),
		quiet: Boolean( options.quiet ),
		debug: Boolean( options.debug ),
	};
}

/**
 * Handles `wrapido config get|set|clear`, the one subcommand that never touches the
 * REST API.
 * @param args    The full positional argument list, starting with `config`.
 * @param options Commander's raw parsed options.
 * @return The process exit code.
 */
async function handleConfigCommand(
	args: string[],
	options: RawOptions
): Promise< number > {
	const [ , sub ] = args;
	switch ( sub ) {
		case 'get': {
			console.log( `url: ${ getDefaultUrl() ?? '(not set)' }` );
			console.log( `username: ${ getDefaultUsername() ?? '(not set)' }` );
			const fileConfig = getFileConfig();
			for ( const [ key, value ] of Object.entries(
				fileConfig?.values ?? {}
			) ) {
				console.log(
					`${ key }: ${ value } ${ pc.dim(
						`(from ${
							fileConfig?.origins[ key as FileConfigKey ] ?? '?'
						})`
					) }`
				);
			}
			console.log(
				pc.dim( `user-level YAML config: ${ userConfigPath() }` )
			);
			console.log( pc.dim( `config file: ${ configFilePath() }` ) );
			return 0;
		}
		case 'set': {
			if ( ! options.url && ! options.username ) {
				console.error(
					errorText(
						new CliError(
							'config set requires --url and/or --username.'
						),
						options.format
					)
				);
				return 1;
			}
			setDefaults( { url: options.url, username: options.username } );
			console.log( pc.green( 'Success: saved default(s).' ) );
			return 0;
		}
		case 'clear': {
			clearDefaults();
			console.log( pc.green( 'Success: cleared saved defaults.' ) );
			return 0;
		}
		case 'rotate-key': {
			rotateEncryptionKey();
			console.log(
				pc.green( 'Success: rotated the local encryption key.' )
			);
			return 0;
		}
		default: {
			console.error(
				errorText(
					new CliError(
						'Usage: wrapido config <get|set|clear|rotate-key> [--url=] [--username=]'
					),
					options.format
				)
			);
			return 1;
		}
	}
}

/**
 * Handles `wrapido help ...`: resolves the site URL, parses the help arguments,
 * and prints the result.
 * @param args    The positional arguments following `help`.
 * @param options Commander's raw parsed options.
 * @param style
 * @return The process exit code.
 */
async function handleHelpCommand(
	args: string[],
	options: RawOptions,
	style: HelpStyle = 'usage'
): Promise< number > {
	if ( args.length === 0 ) {
		program.outputHelp();
		return 0;
	}
	const flags = toGlobalFlags( options );
	const siteUrl = flags.url ?? getDefaultUrl();
	if ( ! siteUrl ) {
		throw new CliError(
			'Missing --url. Pass --url=<site>, or save a default with: wrapido config set --url=<site>'
		);
	}
	const parsed = parseHelpArgs( args );
	const { output, exitCode } = await runHelpCommand(
		parsed,
		flags,
		siteUrl,
		style
	);
	console.log( output );
	return exitCode;
}

// Sites with self-signed/expired certificates must work: never verify TLS.
disableTlsVerification();

const program = new Command();

program
	.name( 'wrapido' )
	.description( "Talk to any WordPress site's REST API, WP-CLI style." )
	.argument( '[args...]', 'namespace route verb id field=value...' )
	.option( '--url <url>', 'WordPress site URL' )
	.option(
		'--username <username>',
		'Username or email (also WP_USERNAME env var)'
	)
	.option(
		'--password <password>',
		'Password or Application Password (also WP_PASSWORD env var)'
	)
	.option(
		'--client-id <id>',
		'OAuth2 client id, from a manually-created wp-admin Application (for "wrapido auth oauth2 login/add")'
	)
	.option(
		'--client-secret <secret>',
		'OAuth2 client secret (for "wrapido auth oauth2 login/add"; required for add, optional for login)'
	)
	.option(
		'--token <token>',
		'OAuth2 personal access token, generated in wp-admin (for "wrapido auth oauth2 add"; alternative to --client-id/--client-secret)'
	)
	.option(
		'--use-auth <source>',
		'env|none|application-passwords|oauth2 — force which auth source to use, skipping the rest of the normal fallback chain (an explicit --username/--password still wins)'
	)
	.option( '--context <context>', 'view|edit|embed', 'view' )
	.option( '--format <format>', 'table|json|csv|yaml|ids|count|raw', 'table' )
	.option( '--fields <fields>', 'Comma-separated list of fields to display' )
	.option( '--field <field>', 'Display a single field only' )
	.option(
		'--body <json>',
		'Raw JSON body for create/update, overriding field=value args'
	)
	.option(
		'--timeout <ms>',
		'Timeout in milliseconds for every request; overrides all defaults (API calls 20000, discovery/auth 8000, file transfers 300000)'
	)
	.option( '--no-color', 'Disable colored output' )
	.option(
		'--no-truncate',
		'Show full table cell values instead of truncating them to 50 characters'
	)
	.option( '--quiet', 'Suppress spinner/progress output' )
	.option(
		'--debug',
		'Log each HTTP request/response (to stderr) and show extra output on error'
	)
	.helpOption( false )
	.option(
		'-h, --help',
		'Show help for the given namespace/route/verb (WP-CLI-style), or the top-level help if none is given'
	)
	.addHelpText(
		'after',
		`
Examples:
  $ wrapido --url=https://example.com
  $ wrapido wp/v2 --url=https://example.com
  $ wrapido wp/v2 posts --url=https://example.com
  $ wrapido wp/v2 posts list --per_page=5 --format=json --url=https://example.com
  $ wrapido wp/v2 posts get 42 --context=edit --url=https://example.com --username=admin --password=xxxx-xxxx-xxxx-xxxx
  $ wrapido wp/v2 posts create --title="Hello" --status=publish --url=https://example.com
  $ wrapido wp/v2 posts delete 42 --force --url=https://example.com
  $ wrapido wp/v2 media create --file=./cat.jpg --title="Cat" --url=https://example.com
  $ wrapido wp/v2 media create --file=https://example.com/cat.jpg --url=https://example.com
  $ wrapido config set --url=https://example.com --username=admin
  $ wrapido auth application-passwords login https://example.com
  $ wrapido auth application-passwords add https://example.com --username=admin --password=xxxx-xxxx-xxxx-xxxx
  $ wrapido auth application-passwords list
  $ wrapido auth application-passwords remove --all
  $ wrapido auth oauth2 login https://example.com --client-id=abc123
  $ wrapido auth oauth2 add https://example.com --client-id=abc123 --client-secret=xxxx
  $ wrapido config rotate-key
  $ wrapido help wp/v2 posts list --url=https://example.com
  $ wrapido wp/v2 posts --help --url=https://example.com
  $ wrapido wp/v2 posts create --help --url=https://example.com

Dynamic field/query arguments (e.g. --per_page=, --title=, --force) are passed
straight through to the WordPress REST API and are not fixed ahead of time —
run "wrapido <namespace> <route>" to see which ones a given route supports.
"list --per_page=-1" fetches every page, using the route's maximum page size.
`
	)
	.action( async ( args: string[], rawOptions: RawOptions ) => {
		let options = rawOptions;
		setColorEnabled( options.color && colorByDefault() );
		setTruncateEnabled( options.truncate !== false );
		try {
			options = applyFileConfig( rawOptions );
			setColorEnabled( options.color && colorByDefault() );
			if ( args[ 0 ] === 'config' ) {
				if ( options.help ) {
					console.log(
						'Usage: wrapido config <get|set|clear|rotate-key> [--url=] [--username=]'
					);
					process.exitCode = 0;
					return;
				}
				process.exitCode = await handleConfigCommand( args, options );
				return;
			}

			if ( args[ 0 ] === 'auth' ) {
				if ( options.help ) {
					// Validate a given type the same way a real invocation
					// would (bare `wrapido auth --help`, with no type at all, is
					// exempt — that's just asking for the general usage
					// below) — otherwise `--help` would silently accept a
					// bogus type and exit 0 where every other invocation
					// shape correctly rejects it.
					if ( args[ 1 ] !== undefined ) {
						assertKnownAuthType( args[ 1 ] );
					}
					console.log(
						authUsageText( args[ 1 ] as AuthType | undefined )
					);
					process.exitCode = 0;
					return;
				}
				const flags = toGlobalFlags( options );
				const parsed = parseAuthArgs(
					args.slice( 1 ),
					flags.url ?? getDefaultUrl()
				);
				const { output, exitCode } = await runAuthCommand(
					parsed,
					flags
				);
				console.log( output );
				process.exitCode = exitCode;
				return;
			}

			if ( args[ 0 ] === 'help' ) {
				process.exitCode = await handleHelpCommand(
					args.slice( 1 ),
					options,
					'usage'
				);
				return;
			}

			if ( options.help ) {
				if ( args.length === 0 ) {
					program.outputHelp();
					process.exitCode = 0;
					return;
				}
				process.exitCode = await handleHelpCommand(
					args,
					options,
					'wpcli'
				);
				return;
			}

			const flags = toGlobalFlags( options );
			const siteUrl = flags.url ?? getDefaultUrl();
			if ( ! siteUrl ) {
				throw new CliError(
					'Missing --url. Pass --url=<site>, or save a default with: wrapido config set --url=<site>'
				);
			}

			const parsed = parseCommandArgs( args );
			const { output, exitCode } = await runRestCommand(
				parsed,
				flags,
				siteUrl
			);
			console.log( output );
			process.exitCode = exitCode;
		} catch ( error ) {
			console.error( errorText( error, options.format ) );
			if (
				options.debug &&
				error instanceof Error &&
				! ( error instanceof CliError ) &&
				! ( error instanceof WpApiError )
			) {
				console.error( error.stack );
			}
			process.exitCode = 1;
		}
	} );

await program.parseAsync( normalizeDynamicFlags( process.argv ) );
