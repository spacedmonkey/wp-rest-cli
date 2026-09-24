/**
 * External dependencies
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

/**
 * Internal dependencies
 */
import { CliError } from './errors.js';

/** Global flags a config file may set, and the YAML type each must have. */
const KEY_TYPES = {
	url: 'string',
	context: 'string',
	format: 'string',
	timeout: 'number',
	color: 'boolean',
	quiet: 'boolean',
	debug: 'boolean',
	'use-auth': 'string',
} as const;

export type FileConfigKey = keyof typeof KEY_TYPES;
export type FileConfigValue = string | number | boolean;

/** Keys that are real flags but deliberately not allowed in a file, with why. */
const REJECTED_KEYS: Record< string, string > = {
	password:
		'secrets do not belong in a config file — use WP_PASSWORD or "wrapido auth"',
	'client-secret':
		'secrets do not belong in a config file — pass it on the command line',
	token: 'secrets do not belong in a config file — pass it on the command line',
	username:
		'a username is only useful together with a password — use WP_USERNAME/WP_PASSWORD or "wrapido auth"',
};

/** The merged result of every config file found. */
export interface FileConfig {
	values: Partial< Record< FileConfigKey, FileConfigValue > >;
	/** The file each value in `values` came from. */
	origins: Partial< Record< FileConfigKey, string > >;
	/** Every file that was read, highest precedence first. */
	files: string[];
}

let loaded: FileConfig | undefined;

/**
 * The user-level config file: `WRAPIDO_CONFIG_PATH`, else
 * `~/.wrapido/config.yml`.
 * @param env The environment to read `WRAPIDO_CONFIG_PATH` from.
 * @return The (possibly nonexistent) path.
 */
export function userConfigPath( env: NodeJS.ProcessEnv = process.env ): string {
	return (
		env.WRAPIDO_CONFIG_PATH || join( homedir(), '.wrapido', 'config.yml' )
	);
}

/**
 * Finds the nearest file called `name`, searching `start` and then each parent directory.
 * @param name  The file name to look for.
 * @param start The directory to start from.
 * @return The file's path, or undefined if there is none.
 */
function findUpward( name: string, start: string ): string | undefined {
	for ( let dir = resolve( start ); ; dir = dirname( dir ) ) {
		const candidate = join( dir, name );
		if ( existsSync( candidate ) ) {
			return candidate;
		}
		if ( dirname( dir ) === dir ) {
			return undefined;
		}
	}
}

/**
 * Reads and validates one config file.
 * @param  file The file to read.
 * @return Its settings.
 * @throws {CliError} On malformed YAML, an unknown or forbidden key, or a wrong value type.
 */
function readConfigFile(
	file: string
): Partial< Record< FileConfigKey, FileConfigValue > > {
	let data: unknown;
	try {
		data = parseYaml( readFileSync( file, 'utf8' ) );
	} catch ( error ) {
		throw new CliError(
			`Could not read config file ${ file }: ${
				error instanceof Error ? error.message : String( error )
			}`
		);
	}
	if ( data === null || data === undefined ) {
		return {};
	}
	if ( typeof data !== 'object' || Array.isArray( data ) ) {
		throw new CliError(
			`Config file ${ file } must be a YAML mapping of flag names to values.`
		);
	}
	const values: Partial< Record< FileConfigKey, FileConfigValue > > = {};
	for ( const [ key, value ] of Object.entries( data ) ) {
		if ( key in REJECTED_KEYS ) {
			throw new CliError(
				`Config file ${ file }: "${ key }" is not allowed — ${ REJECTED_KEYS[ key ] }.`
			);
		}
		if ( ! ( key in KEY_TYPES ) ) {
			throw new CliError(
				`Config file ${ file }: unknown key "${ key }". Allowed keys: ${ Object.keys(
					KEY_TYPES
				).join( ', ' ) }.`
			);
		}
		const expected = KEY_TYPES[ key as FileConfigKey ];
		if ( typeof value !== expected ) {
			throw new CliError(
				`Config file ${ file }: "${ key }" must be a ${ expected } (got ${ JSON.stringify(
					value
				) }).`
			);
		}
		values[ key as FileConfigKey ] = value as FileConfigValue;
	}
	return values;
}

/**
 * Loads and merges every config file, then remembers the result for
 * {@link getFileConfig}. Precedence, highest first: `wrapido.local.yml`,
 * `wrapido.yml` (each the nearest one at or above `cwd`), then the user-level file.
 * @param cwd The directory to search upward from.
 * @param env The environment to read `WRAPIDO_CONFIG_PATH` from.
 * @return The merged config.
 */
export function loadFileConfig(
	cwd: string = process.cwd(),
	env: NodeJS.ProcessEnv = process.env
): FileConfig {
	const candidates = [
		findUpward( 'wrapido.local.yml', cwd ),
		findUpward( 'wrapido.yml', cwd ),
		userConfigPath( env ),
	].filter( ( f ): f is string => f !== undefined && existsSync( f ) );

	const config: FileConfig = { values: {}, origins: {}, files: candidates };
	// Lowest precedence first, so later files overwrite earlier ones.
	for ( const file of [ ...candidates ].reverse() ) {
		for ( const [ key, value ] of Object.entries(
			readConfigFile( file )
		) ) {
			config.values[ key as FileConfigKey ] = value;
			config.origins[ key as FileConfigKey ] = file;
		}
	}
	loaded = config;
	return config;
}

/**
 * The config {@link loadFileConfig} last loaded — lets code far from `cli.ts`
 * (e.g. `getDefaultUrl`) see it without threading it through every call.
 * @return The loaded config, or undefined before it is loaded.
 */
export function getFileConfig(): FileConfig | undefined {
	return loaded;
}
