/**
 * External dependencies
 */
import { Command } from 'commander';
import process from 'node:process';

/**
 * Internal dependencies
 */
import {
	parseCommandArgs,
	runRestCommand,
	parseHelpArgs,
	runHelpCommand,
} from './commands/rest.js';
import {
	getDefaultUrl,
	getDefaultUsername,
	setDefaults,
	clearDefaults,
	configFilePath,
} from './config.js';
import { formatErrorForDisplay, CliError, WpApiError } from './core/errors.js';
import type { Context, GlobalFlags, OutputFormat } from './types.js';
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
	'context',
	'format',
	'fields',
	'field',
	'content',
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

interface RawOptions {
	url?: string;
	username?: string;
	password?: string;
	context: string;
	format: string;
	fields?: string;
	field?: string;
	content?: string;
	color: boolean;
	quiet?: boolean;
	debug?: boolean;
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
	return {
		url: options.url,
		username: options.username,
		password: options.password,
		context: options.context as Context,
		format: options.format as OutputFormat,
		fields: options.fields,
		field: options.field,
		content: options.content,
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
		default: {
			console.error(
				formatErrorForDisplay(
					new CliError(
						'Usage: wp config <get|set|clear> [--url=] [--username=]'
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
 * @return The process exit code.
 */
async function handleHelpCommand(
	args: string[],
	options: RawOptions
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
	const { output, exitCode } = await runHelpCommand( parsed, flags, siteUrl );
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
	.option( '--context <context>', 'view|edit|embed', 'view' )
	.option( '--format <format>', 'table|json|csv|yaml|ids|count|raw', 'table' )
	.option( '--fields <fields>', 'Comma-separated list of fields to display' )
	.option( '--field <field>', 'Display a single field only' )
	.option(
		'--content <content>',
		'Raw JSON body for create/update, overriding field=value args'
	)
	.option( '--no-color', 'Disable colored output' )
	.option( '--quiet', 'Suppress spinner/progress output' )
	.option(
		'--debug',
		'Log each HTTP request/response (to stderr) and show extra output on error'
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
  $ wp-rest-cli config set --url=https://example.com --username=admin
  $ wp-rest-cli help wp/v2 posts list --url=https://example.com

Dynamic field/query arguments (e.g. --per_page=, --title=, --force) are passed
straight through to the WordPress REST API and are not fixed ahead of time —
run "wp-rest-cli <namespace> <route>" to see which ones a given route supports.
`
	)
	.action( async ( args: string[], options: RawOptions ) => {
		setColorEnabled( options.color );
		try {
			if ( args[ 0 ] === 'config' ) {
				process.exitCode = await handleConfigCommand( args, options );
				return;
			}

			if ( args[ 0 ] === 'help' ) {
				process.exitCode = await handleHelpCommand(
					args.slice( 1 ),
					options
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
