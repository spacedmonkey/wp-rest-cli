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
import { formatErrorForDisplay, CliError, WpApiError } from './core/errors.js';
import type {
	AuthSource,
	Context,
	GlobalFlags,
	OutputFormat,
} from './types.js';
import { pc, setColorEnabled } from './ui.js';

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
	'quiet',
	'debug',
	'help',
] );

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
	quiet?: boolean;
	debug?: boolean;
	help?: boolean;
}

/**
 * Validates and narrows Commander's raw parsed options into typed {@link GlobalFlags}.
 * Color is on by default; `--no-color` is the only way to turn it off.
 * @param options Commander's raw parsed options.
 * @return The validated global flags.
 */
function toGlobalFlags( options: RawOptions ): GlobalFlags {
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
		timeout: parseTimeout( options.timeout ),
		color: options.color,
		quiet: Boolean( options.quiet ),
		debug: Boolean( options.debug ),
	};
}

/**
 * Handles `wp config get|set|clear`, the one subcommand that never touches the
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
			console.log( pc.dim( `config file: ${ configFilePath() }` ) );
			return 0;
		}
		case 'set': {
			if ( ! options.url && ! options.username ) {
				console.error(
					formatErrorForDisplay(
						new CliError(
							'config set requires --url and/or --username.'
						)
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
				formatErrorForDisplay(
					new CliError(
						'Usage: wp config <get|set|clear|rotate-key> [--url=] [--username=]'
					)
				)
			);
			return 1;
		}
	}
}

/**
 * Handles `wp help ...`: resolves the site URL, parses the help arguments,
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
			'Missing --url. Pass --url=<site>, or save a default with: wp-rest-cli config set --url=<site>'
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

const program = new Command();

program
	.name( 'wp-rest-cli' )
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
		'OAuth2 client id, from a manually-created wp-admin Application (for "wp auth oauth2 login/add")'
	)
	.option(
		'--client-secret <secret>',
		'OAuth2 client secret (for "wp auth oauth2 login/add"; required for add, optional for login)'
	)
	.option(
		'--token <token>',
		'OAuth2 personal access token, generated in wp-admin (for "wp auth oauth2 add"; alternative to --client-id/--client-secret)'
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
		'Timeout in milliseconds for file uploads/downloads (default 300000)'
	)
	.option( '--no-color', 'Disable colored output' )
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
  $ wp-rest-cli --url=https://example.com
  $ wp-rest-cli wp/v2 --url=https://example.com
  $ wp-rest-cli wp/v2 posts --url=https://example.com
  $ wp-rest-cli wp/v2 posts list --per_page=5 --format=json --url=https://example.com
  $ wp-rest-cli wp/v2 posts get 42 --context=edit --url=https://example.com --username=admin --password=xxxx-xxxx-xxxx-xxxx
  $ wp-rest-cli wp/v2 posts create --title="Hello" --status=publish --url=https://example.com
  $ wp-rest-cli wp/v2 posts delete 42 --force --url=https://example.com
  $ wp-rest-cli wp/v2 media create --file=./cat.jpg --title="Cat" --url=https://example.com
  $ wp-rest-cli wp/v2 media create --file=@https://example.com/cat.jpg --url=https://example.com
  $ wp-rest-cli config set --url=https://example.com --username=admin
  $ wp-rest-cli auth application-passwords login https://example.com
  $ wp-rest-cli auth application-passwords add https://example.com --username=admin --password=xxxx-xxxx-xxxx-xxxx
  $ wp-rest-cli auth application-passwords list
  $ wp-rest-cli auth application-passwords remove --all
  $ wp-rest-cli auth oauth2 login https://example.com --client-id=abc123
  $ wp-rest-cli auth oauth2 add https://example.com --client-id=abc123 --client-secret=xxxx
  $ wp-rest-cli config rotate-key
  $ wp-rest-cli help wp/v2 posts list --url=https://example.com
  $ wp-rest-cli wp/v2 posts --help --url=https://example.com
  $ wp-rest-cli wp/v2 posts create --help --url=https://example.com

Dynamic field/query arguments (e.g. --per_page=, --title=, --force) are passed
straight through to the WordPress REST API and are not fixed ahead of time —
run "wp-rest-cli <namespace> <route>" to see which ones a given route supports.
`
	)
	.action( async ( args: string[], options: RawOptions ) => {
		setColorEnabled( options.color );
		try {
			if ( args[ 0 ] === 'config' ) {
				if ( options.help ) {
					console.log(
						'Usage: wp config <get|set|clear|rotate-key> [--url=] [--username=]'
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
					// would (bare `wp auth --help`, with no type at all, is
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
					'Missing --url. Pass --url=<site>, or save a default with: wp-rest-cli config set --url=<site>'
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
			console.error( formatErrorForDisplay( error ) );
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
