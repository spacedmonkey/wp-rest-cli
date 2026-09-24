/**
 * External dependencies
 */
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Internal dependencies
 */
import { loadFileConfig } from '../../src/core/file-config.js';

let root: string;
let cwd: string;
let userFile: string;
const env = () => ( { WRAPIDO_CONFIG_PATH: userFile } );

beforeEach( () => {
	root = mkdtempSync( join( tmpdir(), 'wrapido-cfg-' ) );
	cwd = join( root, 'a', 'b' );
	mkdirSync( cwd, { recursive: true } );
	userFile = join( root, 'user.yml' );
} );

afterEach( () => rmSync( root, { recursive: true, force: true } ) );

describe( 'loadFileConfig', () => {
	it( 'finds files in parent directories', () => {
		writeFileSync( join( root, 'wrapido.yml' ), 'format: json\n' );
		expect( loadFileConfig( cwd, env() ).values ).toEqual( {
			format: 'json',
		} );
	} );

	it( 'layers local over project over user, per key', () => {
		writeFileSync( userFile, 'format: csv\ncontext: edit\ntimeout: 5\n' );
		writeFileSync(
			join( root, 'wrapido.yml' ),
			'format: yaml\ncontext: embed\n'
		);
		writeFileSync( join( cwd, 'wrapido.local.yml' ), 'format: json\n' );
		const { values, origins } = loadFileConfig( cwd, env() );
		expect( values ).toEqual( {
			format: 'json',
			context: 'embed',
			timeout: 5,
		} );
		expect( origins.format ).toBe( join( cwd, 'wrapido.local.yml' ) );
		expect( origins.timeout ).toBe( userFile );
	} );

	it( 'treats missing and empty files as no config', () => {
		expect( loadFileConfig( cwd, env() ).values ).toEqual( {} );
		writeFileSync( userFile, '' );
		expect( loadFileConfig( cwd, env() ).values ).toEqual( {} );
	} );

	it.each( [
		[ 'password: x', /"password" is not allowed/ ],
		[ 'username: x', /"username" is not allowed/ ],
		[ 'nope: 1', /unknown key "nope"/ ],
		[ 'timeout: fast', /"timeout" must be a number/ ],
		[ 'quiet: "yes"', /"quiet" must be a boolean/ ],
		[ '- a', /must be a YAML mapping/ ],
		[ 'a: [', /Could not read config file/ ],
	] )( 'rejects %s, naming the file', ( yaml, message ) => {
		writeFileSync( userFile, yaml );
		expect( () => loadFileConfig( cwd, env() ) ).toThrow( message );
		expect( () => loadFileConfig( cwd, env() ) ).toThrow( userFile );
	} );
} );
