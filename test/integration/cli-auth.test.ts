/**
 * External dependencies
 */
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Internal dependencies
 */
import { runCli } from './fixtures/run-cli.js';
import {
	getRevokedApplicationPasswordUuids,
	startFixture,
	type Fixture,
} from './fixtures/server.js';

let fixture: Fixture;

beforeAll( async () => {
	fixture = await startFixture();
} );

afterAll( async () => {
	await fixture.close();
} );

describe( 'auth', () => {
	// Every stored credential goes through `conf`, keyed off
	// XDG_CONFIG_HOME - isolating it to a scratch directory per test file
	// (rather than reusing `run()`'s default env) keeps these tests from
	// reading or clobbering a real config file on the machine running them.
	let authConfigDir: string;

	beforeAll( async () => {
		authConfigDir = await mkdtemp(
			join( tmpdir(), 'wp-rest-cli-auth-it-' )
		);
	} );

	afterAll( async () => {
		await rm( authConfigDir, { recursive: true, force: true } );
	} );

	// `wp auth` now requires a `<type>` positional right after `auth`
	// (`wp auth <type> <verb> ...`) — inserted here centrally, rather than
	// in every call site below, so this is the one place that would need
	// to change if a test ever needed to exercise a different type.
	const AUTH_TYPE = 'application-passwords';

	function runAuth( args: string[] ) {
		const withType =
			args[ 0 ] === 'auth'
				? [ args[ 0 ], AUTH_TYPE, ...args.slice( 1 ) ]
				: args;
		return runCli( [ ...withType, '--quiet', '--no-color' ], {
			env: { XDG_CONFIG_HOME: authConfigDir },
		} );
	}

	// Best-effort cleanup between tests that each need a known starting
	// state for `fixture.baseUrl` regardless of what earlier tests in this
	// file left behind — `runAuth` never rejects (execa's `reject: false`),
	// so a "nothing to remove" failure here is fine.
	async function removeIfPresent( url: string ) {
		await runAuth( [ 'auth', 'remove', url ] );
	}

	/**
	 * Drives a full `auth login` round-trip against `fixture.baseUrl`,
	 * simulating the browser's approval with the given username, and
	 * returns once the CLI process has exited (asserting success).
	 * @param userLogin The username to simulate approving as.
	 * @param url       The site to log in against (defaults to the fixture).
	 */
	async function simulateLogin( userLogin: string, url = fixture.baseUrl ) {
		const child = runCli(
			[ 'auth', AUTH_TYPE, 'login', url, '--quiet', '--no-color' ],
			{ env: { XDG_CONFIG_HOME: authConfigDir } }
		);
		let stdout = '';
		const authorizeUrlFound = new Promise< string >( ( resolve ) => {
			child.stdout?.on( 'data', ( chunk: Buffer ) => {
				stdout += chunk.toString();
				const match = stdout.match(
					/https?:\/\/\S*authorize-application\.php\?\S+/
				);
				if ( match ) {
					resolve( match[ 0 ] );
				}
			} );
		} );
		const authorizeUrl = await authorizeUrlFound;
		const successUrl = new URL( authorizeUrl ).searchParams.get(
			'success_url'
		) as string;
		await fetch(
			`${ successUrl }?user_login=${ userLogin }&password=pw-${ userLogin }`
		);
		const result = await child;
		expect( result.exitCode ).toBe( 0 );
		return result;
	}

	it( 'adds and lists a manually-supplied credential', async () => {
		const add = await runAuth( [
			'auth',
			'add',
			fixture.baseUrl,
			'--username=admin',
			'--password=secret-app-pw',
		] );
		expect( add.exitCode ).toBe( 0 );
		expect( add.stdout ).toContain( 'Success' );

		const list = await runAuth( [ 'auth', 'list', '--format=json' ] );
		expect( list.exitCode ).toBe( 0 );
		expect( JSON.parse( list.stdout ) ).toContainEqual( {
			url: fixture.baseUrl,
			username: 'admin',
			authMethod: 'password',
			default: '',
		} );
	} );

	it( 'falls back to the global --url flag when the positional <url> is omitted', async () => {
		await removeIfPresent( fixture.baseUrl );

		// No positional <url> after `add` here — only the global --url
		// flag, which every other command already accepts. This is what a
		// user reasonably expects to work rather than needing to repeat
		// the site twice.
		const add = await runCli(
			[
				'auth',
				AUTH_TYPE,
				'add',
				`--url=${ fixture.baseUrl }`,
				'--username=admin',
				'--password=secret-app-pw',
				'--quiet',
				'--no-color',
			],
			{ env: { XDG_CONFIG_HOME: authConfigDir } }
		);
		expect( add.exitCode ).toBe( 0 );
		expect( add.stdout ).toContain( 'Success' );

		const list = await runAuth( [ 'auth', 'list', '--format=json' ] );
		expect( JSON.parse( list.stdout ) ).toContainEqual(
			expect.objectContaining( {
				url: fixture.baseUrl,
				username: 'admin',
			} )
		);

		await removeIfPresent( fixture.baseUrl );
	} );

	it( 'requires both --username and --password for add', async () => {
		const result = await runAuth( [
			'auth',
			'add',
			fixture.baseUrl,
			'--username=admin',
		] );
		expect( result.exitCode ).toBe( 1 );
		expect( result.stderr ).toContain(
			'requires --username and --password'
		);
	} );

	it( 'uses a stored credential automatically when no --username/--password flags are given', async () => {
		await runAuth( [
			'auth',
			'add',
			fixture.baseUrl,
			'--username=admin',
			'--password=secret-app-pw',
		] );
		const result = await runAuth( [
			'wp/v2',
			'widgets',
			'list',
			`--url=${ fixture.baseUrl }`,
			'--debug',
		] );
		expect( result.exitCode ).toBe( 0 );
		expect( result.stderr ).toContain( 'Authorization: Basic <redacted>' );
	} );

	it( 'removes a stored credential, and errors on a second removal', async () => {
		await runAuth( [
			'auth',
			'add',
			fixture.baseUrl,
			'--username=admin',
			'--password=secret-app-pw',
		] );
		const removed = await runAuth( [ 'auth', 'remove', fixture.baseUrl ] );
		expect( removed.exitCode ).toBe( 0 );
		expect( removed.stdout ).toContain( 'Success' );

		const removedAgain = await runAuth( [
			'auth',
			'remove',
			fixture.baseUrl,
		] );
		expect( removedAgain.exitCode ).toBe( 1 );
		expect( removedAgain.stderr ).toContain( 'No stored credential for' );
	} );

	it( 'sets and reports the default site via use/status', async () => {
		const use = await runAuth( [ 'auth', 'use', fixture.baseUrl ] );
		expect( use.exitCode ).toBe( 0 );

		const status = await runAuth( [ 'auth', 'status' ] );
		expect( status.exitCode ).toBe( 0 );
		expect( status.stdout ).toContain(
			`default site: ${ fixture.baseUrl }`
		);
	} );

	it( 'reports a clear error when logging in against a site with no Application Passwords support', async () => {
		const result = await runAuth( [
			'auth',
			'login',
			`${ fixture.baseUrl }/no-app-passwords`,
		] );
		expect( result.exitCode ).toBe( 1 );
		expect( result.stderr ).toContain(
			'does not support Application Passwords'
		);
		expect( result.stderr ).toContain(
			'wp auth application-passwords add'
		);
	} );

	it( 'runs the full browser-based login flow via the local callback server', async () => {
		const result = await simulateLogin( 'cli-test-user' );
		expect( result.stdout ).toContain( 'Success' );
		expect( result.stdout ).toContain( 'cli-test-user' );

		await runAuth( [ 'auth', 'use', fixture.baseUrl ] );
		const list = await runAuth( [ 'auth', 'list', '--format=json' ] );
		expect( JSON.parse( list.stdout ) ).toContainEqual( {
			url: fixture.baseUrl,
			username: 'cli-test-user',
			authMethod: 'application-password',
			default: '*',
		} );
	} );

	it( 'blocks auth add when the site rejects the credentials (401)', async () => {
		await removeIfPresent( fixture.baseUrl );

		const result = await runAuth( [
			'auth',
			'add',
			fixture.baseUrl,
			'--username=admin',
			'--password=wrong-password',
		] );
		expect( result.exitCode ).toBe( 1 );
		expect( result.stderr ).toContain(
			'These credentials were rejected by the site'
		);

		const list = await runAuth( [ 'auth', 'list' ] );
		expect( list.stdout ).toContain( 'No stored credentials' );
	} );

	it( '--skip-verify saves a rejected credential anyway, with no verification', async () => {
		await removeIfPresent( fixture.baseUrl );

		const result = await runAuth( [
			'auth',
			'add',
			fixture.baseUrl,
			'--username=admin',
			'--password=wrong-password',
			'--skip-verify',
		] );
		expect( result.exitCode ).toBe( 0 );
		expect( result.stdout ).toContain( 'Success' );

		const list = await runAuth( [ 'auth', 'list', '--format=json' ] );
		const site = (
			JSON.parse( list.stdout ) as Array< {
				url: string;
				username: string;
				authMethod: string;
			} >
		 ).find( ( s ) => s.url === fixture.baseUrl );
		expect( site ).toMatchObject( {
			username: 'admin',
			authMethod: 'password',
		} );

		await removeIfPresent( fixture.baseUrl );
	} );

	it( 'still removes locally even when the site cannot revoke the credential remotely', async () => {
		await removeIfPresent( fixture.baseUrl );

		// "unrevokable" derives the fixture's reserved uuid
		// (`uuid-unrevokable`), which always 404s on DELETE —
		// deterministically exercises the "revoke failed, still removed
		// locally" path without depending on real network unreachability.
		await simulateLogin( 'unrevokable' );

		const removed = await runAuth( [ 'auth', 'remove', fixture.baseUrl ] );
		expect( removed.exitCode ).toBe( 0 );
		expect( removed.stdout ).toContain( 'could not revoke it on the site' );

		const list = await runAuth( [ 'auth', 'list' ] );
		expect( list.stdout ).toContain( 'No stored credentials' );
	} );

	it( 'revokes the previous Application Password when logging in again for the same site', async () => {
		await removeIfPresent( fixture.baseUrl );

		await simulateLogin( 'revoke-old-user' );
		await simulateLogin( 'revoke-new-user' );

		expect(
			getRevokedApplicationPasswordUuids().has( 'uuid-revoke-old-user' )
		).toBe( true );

		await removeIfPresent( fixture.baseUrl );
	} );

	it( 'auth remove --all revokes what it can and clears every stored credential', async () => {
		// Several sequential `tsx` subprocess spawns (login, add, remove --all,
		// list) push this past vitest's 5s default testTimeout.
		await removeIfPresent( fixture.baseUrl );
		const secondSite = `${ fixture.baseUrl }/no-app-passwords`;
		await removeIfPresent( secondSite );

		await simulateLogin( 'remove-all-user' );
		await runAuth( [
			'auth',
			'add',
			secondSite,
			'--username=admin',
			'--password=whatever',
			'--skip-verify',
		] );

		const result = await runAuth( [ 'auth', 'remove', '--all' ] );
		expect( result.exitCode ).toBe( 0 );
		expect( result.stdout ).toContain( 'removed 2 stored credential' );
		expect( result.stdout ).toContain( 'revoked 1' );

		expect(
			getRevokedApplicationPasswordUuids().has( 'uuid-remove-all-user' )
		).toBe( true );

		const list = await runAuth( [ 'auth', 'list' ] );
		expect( list.stdout ).toContain( 'No stored credentials' );
	} );

	it( 'wp config rotate-key re-encrypts the store without losing data', async () => {
		await removeIfPresent( fixture.baseUrl );
		await runAuth( [
			'auth',
			'add',
			fixture.baseUrl,
			'--username=admin',
			'--password=whatever',
			'--skip-verify',
		] );
		await runAuth( [ 'auth', 'use', fixture.baseUrl ] );

		const rotate = await runAuth( [ 'config', 'rotate-key' ] );
		expect( rotate.exitCode ).toBe( 0 );
		expect( rotate.stdout ).toContain( 'Success' );

		const list = await runAuth( [ 'auth', 'list', '--format=json' ] );
		const site = (
			JSON.parse( list.stdout ) as Array< { url: string } >
		 ).find( ( s ) => s.url === fixture.baseUrl );
		expect( site ).toBeDefined();

		const status = await runAuth( [ 'auth', 'status' ] );
		expect( status.stdout ).toContain(
			`default site: ${ fixture.baseUrl }`
		);

		await removeIfPresent( fixture.baseUrl );
	} );
} );

describe( 'config store recovery', () => {
	// Each command is its own fresh process/module registry, unlike an
	// in-process dynamic re-import — this is the only way to actually
	// exercise `src/config.ts`'s recovery path for a config file that
	// can't be decrypted with the current key (e.g. the key file and
	// config file came from mismatched backups, or a `rotate-key` was
	// interrupted partway through).
	it( 'recovers instead of crashing when the config file cannot be decrypted, preserving a backup', async () => {
		const recoveryDir = await mkdtemp(
			join( tmpdir(), 'wp-rest-cli-recovery-it-' )
		);
		try {
			const set = await runCli(
				[
					'config',
					'set',
					'--url=https://example.com',
					'--quiet',
					'--no-color',
				],
				{ env: { XDG_CONFIG_HOME: recoveryDir } }
			);
			expect( set.exitCode ).toBe( 0 );

			const get = await runCli(
				[ 'config', 'get', '--quiet', '--no-color' ],
				{ env: { XDG_CONFIG_HOME: recoveryDir } }
			);
			const configFileLine = get.stdout
				.split( '\n' )
				.find( ( line ) => line.startsWith( 'config file:' ) );
			const configFilePath = configFileLine
				?.replace( 'config file:', '' )
				.trim() as string;
			expect( existsSync( configFilePath ) ).toBe( true );

			// Simulate the key file and config file falling out of sync.
			writeFileSync(
				configFilePath,
				Buffer.from( [ 0, 1, 2, 3, 255, 254 ] )
			);

			const afterCorruption = await runCli(
				[ 'config', 'get', '--quiet', '--no-color' ],
				{ env: { XDG_CONFIG_HOME: recoveryDir } }
			);
			expect( afterCorruption.exitCode ).toBe( 0 );
			expect( afterCorruption.stdout ).toContain( 'url: (not set)' );
			expect( afterCorruption.stderr ).toContain( 'could not be read' );

			const dirEntries = readdirSync( dirname( configFilePath ) );
			expect(
				dirEntries.some( ( name ) => name.includes( '.unreadable-' ) )
			).toBe( true );
		} finally {
			await rm( recoveryDir, { recursive: true, force: true } );
		}
	} );
} );
