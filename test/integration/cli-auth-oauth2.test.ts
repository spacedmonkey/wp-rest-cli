/**
 * External dependencies
 */
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Internal dependencies
 */
import { runCli } from './fixtures/run-cli.js';
import {
	getOAuth2RouteHitCounts,
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

describe( 'oauth2', () => {
	// Same isolation rationale as the `auth` describe block above: a
	// scratch XDG_CONFIG_HOME per test file, not the default `run()`
	// helper, so these tests never read/clobber a real config file.
	let authConfigDir: string;

	beforeAll( async () => {
		authConfigDir = await mkdtemp( join( tmpdir(), 'wrapido-oauth2-it-' ) );
	} );

	afterAll( async () => {
		await rm( authConfigDir, { recursive: true, force: true } );
	} );

	function runOAuth2( args: string[] ) {
		const withType =
			args[ 0 ] === 'auth'
				? [ args[ 0 ], 'oauth2', ...args.slice( 1 ) ]
				: args;
		return runCli( [ ...withType, '--quiet', '--no-color' ], {
			env: { XDG_CONFIG_HOME: authConfigDir },
		} );
	}

	function runAppPasswordsAuth( args: string[] ) {
		const withType =
			args[ 0 ] === 'auth'
				? [ args[ 0 ], 'application-passwords', ...args.slice( 1 ) ]
				: args;
		return runCli( [ ...withType, '--quiet', '--no-color' ], {
			env: { XDG_CONFIG_HOME: authConfigDir },
		} );
	}

	function runRestWithConfig( args: string[] ) {
		return runCli(
			[ ...args, `--url=${ fixture.baseUrl }`, '--quiet', '--no-color' ],
			{ env: { XDG_CONFIG_HOME: authConfigDir } }
		);
	}

	async function removeIfPresent( url: string ) {
		await runOAuth2( [ 'auth', 'remove', url ] );
	}

	/**
	 * Spawns `wrapido auth oauth2 login`, captures the printed authorize URL,
	 * and returns the still-running child alongside that URL — callers
	 * decide how to complete the flow (follow the fixture's own redirect
	 * like a browser would, or hit the local callback server directly to
	 * simulate a tampered/invalid callback).
	 * @param options          Options.
	 * @param options.url      The site to log in against.
	 * @param options.clientId The OAuth2 client id to use.
	 * @param options.port     The fixed local callback port to bind to.
	 */
	function startOAuth2Login( options: {
		url?: string;
		clientId?: string;
		port: number;
	} ) {
		const {
			url = fixture.baseUrl,
			clientId = 'test-client-id',
			port,
		} = options;
		const child = runCli(
			[
				'auth',
				'oauth2',
				'login',
				url,
				`--client-id=${ clientId }`,
				`port=${ port }`,
				'--quiet',
				'--no-color',
			],
			{ env: { XDG_CONFIG_HOME: authConfigDir } }
		);
		let stdout = '';
		const authorizeUrlFound = new Promise< string >( ( resolve ) => {
			child.stdout?.on( 'data', ( chunk: Buffer ) => {
				stdout += chunk.toString();
				const match = stdout.match(
					/https?:\/\/\S*oauth2-authorize\?\S+/
				);
				if ( match ) {
					resolve( match[ 0 ] );
				}
			} );
		} );
		return { child, authorizeUrlFound };
	}

	/**
	 * Drives a full `auth oauth2 login` round-trip, following the printed
	 * authorize URL exactly the way a browser would — a plain `fetch`
	 * follows the fixture's redirect through to the CLI's own local
	 * callback server — and returns once the CLI process has exited.
	 * @param options          Options.
	 * @param options.url      The site to log in against.
	 * @param options.clientId The OAuth2 client id to use.
	 * @param options.port     The fixed local callback port to bind to.
	 */
	async function simulateOAuth2Login( options: {
		url?: string;
		clientId?: string;
		port: number;
	} ) {
		const { child, authorizeUrlFound } = startOAuth2Login( options );
		const authorizeUrl = await authorizeUrlFound;
		await fetch( authorizeUrl );
		return child;
	}

	it( 'adds and lists a client_credentials credential', async () => {
		await removeIfPresent( fixture.baseUrl );

		const add = await runOAuth2( [
			'auth',
			'add',
			fixture.baseUrl,
			'--client-id=test-client-id',
			'--client-secret=shh',
		] );
		expect( add.exitCode ).toBe( 0 );
		expect( add.stdout ).toContain( 'Success' );

		const list = await runOAuth2( [ 'auth', 'list', '--format=json' ] );
		expect( list.exitCode ).toBe( 0 );
		expect( JSON.parse( list.stdout ) ).toContainEqual( {
			url: fixture.baseUrl,
			clientId: 'test-client-id',
			grantType: 'client_credentials',
			default: '',
		} );

		await removeIfPresent( fixture.baseUrl );
	} );

	it( 'adds and lists a personal token credential, with no client id shown', async () => {
		await removeIfPresent( fixture.baseUrl );

		const add = await runOAuth2( [
			'auth',
			'add',
			fixture.baseUrl,
			'--token=test-personal-token-valid',
		] );
		expect( add.exitCode ).toBe( 0 );
		expect( add.stdout ).toContain( 'Success' );

		const list = await runOAuth2( [ 'auth', 'list', '--format=json' ] );
		expect( list.exitCode ).toBe( 0 );
		expect( JSON.parse( list.stdout ) ).toContainEqual( {
			url: fixture.baseUrl,
			clientId: '',
			grantType: 'personal_token',
			default: '',
		} );

		await runOAuth2( [ 'auth', 'use', fixture.baseUrl ] );
		const status = await runOAuth2( [ 'auth', 'status' ] );
		expect( status.exitCode ).toBe( 0 );
		expect( status.stdout ).toContain(
			'authenticated via OAuth2 (personal token)'
		);

		const request = await runRestWithConfig( [
			'wp/v2',
			'widgets',
			'list',
			'--use-auth=oauth2',
			'--debug',
		] );
		expect( request.exitCode ).toBe( 0 );
		expect( request.stderr ).toContain(
			'Authorization: Bearer <redacted>'
		);

		await removeIfPresent( fixture.baseUrl );
	} );

	it( 'blocks adding an unrecognized personal token unless skip-verify=true is passed', async () => {
		await removeIfPresent( fixture.baseUrl );

		const rejected = await runOAuth2( [
			'auth',
			'add',
			fixture.baseUrl,
			'--token=not-a-real-token',
		] );
		expect( rejected.exitCode ).toBe( 1 );
		expect( rejected.stderr ).toContain(
			'This personal token was rejected by the site'
		);

		const list = await runOAuth2( [ 'auth', 'list', '--format=json' ] );
		expect( list.stdout ).toContain( 'No stored credentials' );

		const skipped = await runOAuth2( [
			'auth',
			'add',
			fixture.baseUrl,
			'--token=not-a-real-token',
			'skip-verify=true',
		] );
		expect( skipped.exitCode ).toBe( 0 );
		expect( skipped.stdout ).toContain( 'Success' );

		const listAfter = await runOAuth2( [
			'auth',
			'list',
			'--format=json',
		] );
		expect( JSON.parse( listAfter.stdout ) ).toContainEqual(
			expect.objectContaining( {
				url: fixture.baseUrl,
				clientId: '',
				grantType: 'personal_token',
			} )
		);

		await removeIfPresent( fixture.baseUrl );
	} );

	it( 'rejects passing both --token and --client-id/--client-secret to add', async () => {
		await removeIfPresent( fixture.baseUrl );

		const result = await runOAuth2( [
			'auth',
			'add',
			fixture.baseUrl,
			'--token=test-personal-token-valid',
			'--client-id=test-client-id',
			'--client-secret=shh',
		] );
		expect( result.exitCode ).toBe( 1 );
		expect( result.stderr ).toContain(
			'pass either --token (a personal access token) or --client-id/--client-secret'
		);

		const list = await runOAuth2( [ 'auth', 'list', '--format=json' ] );
		expect( list.stdout ).toContain( 'No stored credentials' );
	} );

	it( 'falls back to the global --url flag when the positional <url> is omitted', async () => {
		await removeIfPresent( fixture.baseUrl );

		// No positional <url> after `add` here — only the global --url
		// flag, which every other command already accepts.
		const add = await runCli(
			[
				'auth',
				'oauth2',
				'add',
				`--url=${ fixture.baseUrl }`,
				'--client-id=test-client-id',
				'--client-secret=shh',
				'--quiet',
				'--no-color',
			],
			{ env: { XDG_CONFIG_HOME: authConfigDir } }
		);
		expect( add.exitCode ).toBe( 0 );
		expect( add.stdout ).toContain( 'Success' );

		const list = await runOAuth2( [ 'auth', 'list', '--format=json' ] );
		expect( JSON.parse( list.stdout ) ).toContainEqual(
			expect.objectContaining( {
				url: fixture.baseUrl,
				clientId: 'test-client-id',
			} )
		);

		await removeIfPresent( fixture.baseUrl );
	} );

	it( 'reports a hint about the Client Credentials Grant setting when the application does not support that grant', async () => {
		const result = await runOAuth2( [
			'auth',
			'add',
			fixture.baseUrl,
			'--client-id=test-client-id-no-cc',
			'--client-secret=shh',
		] );
		expect( result.exitCode ).toBe( 1 );
		expect( result.stderr ).toContain( 'Client Credentials Grant' );
	} );

	it( 'reports a distinct, more accurate error when the site never routes the request to client_credentials handling at all', async () => {
		// Distinguishes this from the "grant not enabled" case above:
		// `rest_missing_callback_param`/`rest_invalid_param` only ever
		// come from the plugin's authorization_code validation path, so
		// seeing one here — rather than the real handle_client_credentials()
		// failure's `oauth2.endpoints.token.invalid_client` — means the
		// request never reached client_credentials handling server-side
		// at all (an outdated plugin, stale opcode cache, or a WAF), not
		// that the grant is simply disabled for this Application.
		const result = await runOAuth2( [
			'auth',
			'add',
			fixture.baseUrl,
			'--client-id=test-client-id-wrong-code-path',
			'--client-secret=shh',
		] );
		expect( result.exitCode ).toBe( 1 );
		expect( result.stderr ).toContain(
			'responded as though this were an authorization_code request'
		);
		expect( result.stderr ).toContain(
			'not the same as the grant being disabled'
		);
		expect( result.stderr ).not.toContain( 'Client Credentials Grant' );
	} );

	it( 'runs the full authorization_code login flow via the local callback server', async () => {
		await removeIfPresent( fixture.baseUrl );

		const result = await simulateOAuth2Login( { port: 18801 } );
		expect( result.exitCode ).toBe( 0 );
		expect( result.stdout ).toContain( 'Success' );

		await runOAuth2( [ 'auth', 'use', fixture.baseUrl ] );
		const status = await runOAuth2( [ 'auth', 'status' ] );
		expect( status.stdout ).toContain(
			`default site: ${ fixture.baseUrl }`
		);
		expect( status.stdout ).toContain( 'authenticated via OAuth2' );

		await removeIfPresent( fixture.baseUrl );
	} );

	it( 'reports a clear error when the user cancels authorization (access_denied), without saving anything', async () => {
		const result = await simulateOAuth2Login( {
			port: 18802,
			clientId: 'test-client-id-deny',
		} );
		expect( result.exitCode ).toBe( 1 );
		expect( result.stderr.toLowerCase() ).toContain( 'denied' );

		const list = await runOAuth2( [ 'auth', 'list' ] );
		expect( list.stdout ).not.toContain( fixture.baseUrl );
	} );

	it( 'rejects a callback whose state does not match, without saving anything', async () => {
		const { child, authorizeUrlFound } = startOAuth2Login( {
			port: 18803,
		} );
		await authorizeUrlFound;

		// Hits the CLI's local callback server directly with a bogus
		// state, bypassing the fixture's own authorize endpoint entirely
		// — the CLI must reject this regardless of what a real
		// authorization server would ever send.
		await fetch(
			`http://127.0.0.1:18803/callback?code=whatever&state=not-the-real-state`
		);
		const result = await child;

		expect( result.exitCode ).toBe( 1 );
		expect( result.stderr ).toContain( 'state did not match' );

		const list = await runOAuth2( [ 'auth', 'list' ] );
		expect( list.stdout ).not.toContain( fixture.baseUrl );
	} );

	it( 'fails clearly when the callback port is already in use, rather than hanging', async () => {
		const port = 18804;
		const blocker = net.createServer();
		await new Promise< void >( ( resolve ) =>
			blocker.listen( port, '127.0.0.1', resolve )
		);
		try {
			const result = await runCli(
				[
					'auth',
					'oauth2',
					'login',
					fixture.baseUrl,
					'--client-id=test-client-id',
					`port=${ port }`,
					'--quiet',
					'--no-color',
				],
				{ env: { XDG_CONFIG_HOME: authConfigDir } }
			);
			expect( result.exitCode ).toBe( 1 );
			expect( result.stderr ).toContain( 'already in use' );
		} finally {
			await new Promise< void >( ( resolve ) =>
				blocker.close( () => resolve() )
			);
		}
	} );

	it( 'refuses to attempt anything against a site with no OAuth2 support, before any network call to the authorize/token routes', async () => {
		const before = getOAuth2RouteHitCounts();

		const noSiteUrl = `${ fixture.baseUrl }/no-app-passwords`;
		const loginResult = await runOAuth2( [
			'auth',
			'login',
			noSiteUrl,
			'--client-id=test-client-id',
		] );
		expect( loginResult.exitCode ).toBe( 1 );
		expect( loginResult.stderr ).toContain(
			"doesn't advertise OAuth2 support"
		);

		const addResult = await runOAuth2( [
			'auth',
			'add',
			noSiteUrl,
			'--client-id=test-client-id',
			'--client-secret=shh',
		] );
		expect( addResult.exitCode ).toBe( 1 );
		expect( addResult.stderr ).toContain(
			"doesn't advertise OAuth2 support"
		);

		const after = getOAuth2RouteHitCounts();
		expect( after.authorize ).toBe( before.authorize );
		expect( after.token ).toBe( before.token );
	} );

	it( 'requires --use-auth to disambiguate when both an application-passwords and an oauth2 credential are stored for the same site', async () => {
		await removeIfPresent( fixture.baseUrl );
		await runAppPasswordsAuth( [ 'auth', 'remove', fixture.baseUrl ] );

		await runAppPasswordsAuth( [
			'auth',
			'add',
			fixture.baseUrl,
			'--username=admin',
			'--password=secret-app-pw',
		] );
		await runOAuth2( [
			'auth',
			'add',
			fixture.baseUrl,
			'--client-id=test-client-id',
			'--client-secret=shh',
		] );

		const ambiguous = await runRestWithConfig( [
			'wp/v2',
			'widgets',
			'list',
		] );
		expect( ambiguous.exitCode ).toBe( 1 );
		expect( ambiguous.stderr ).toContain(
			'Both an application-passwords and an oauth2 credential are stored'
		);

		const withAppPasswords = await runRestWithConfig( [
			'wp/v2',
			'widgets',
			'list',
			'--use-auth=application-passwords',
			'--debug',
		] );
		expect( withAppPasswords.exitCode ).toBe( 0 );
		expect( withAppPasswords.stderr ).toContain(
			'Authorization: Basic <redacted>'
		);

		const withOAuth2 = await runRestWithConfig( [
			'wp/v2',
			'widgets',
			'list',
			'--use-auth=oauth2',
			'--debug',
		] );
		expect( withOAuth2.exitCode ).toBe( 0 );
		expect( withOAuth2.stderr ).toContain(
			'Authorization: Bearer <redacted>'
		);

		await runAppPasswordsAuth( [ 'auth', 'remove', fixture.baseUrl ] );
		await removeIfPresent( fixture.baseUrl );
	} );

	it( 'application-passwords remove --all does not remove a stored oauth2 credential for the same site', async () => {
		await runAppPasswordsAuth( [ 'auth', 'remove', fixture.baseUrl ] );
		await removeIfPresent( fixture.baseUrl );

		await runAppPasswordsAuth( [
			'auth',
			'add',
			fixture.baseUrl,
			'--username=admin',
			'--password=secret-app-pw',
		] );
		await runOAuth2( [
			'auth',
			'add',
			fixture.baseUrl,
			'--client-id=test-client-id',
			'--client-secret=shh',
		] );

		const removeAll = await runAppPasswordsAuth( [
			'auth',
			'remove',
			'--all',
		] );
		expect( removeAll.exitCode ).toBe( 0 );

		const oauth2List = await runOAuth2( [
			'auth',
			'list',
			'--format=json',
		] );
		// Matched on the credential fields only, not `default` — an
		// earlier test in this file may have already set this site as
		// the default `--url` via `auth oauth2 use`, and that's not what
		// this test is checking.
		expect( JSON.parse( oauth2List.stdout ) ).toContainEqual(
			expect.objectContaining( {
				url: fixture.baseUrl,
				clientId: 'test-client-id',
				grantType: 'client_credentials',
			} )
		);

		await removeIfPresent( fixture.baseUrl );
	} );

	it( 'removes a stored oauth2 credential purely locally, and errors on a second removal', async () => {
		await runOAuth2( [
			'auth',
			'add',
			fixture.baseUrl,
			'--client-id=test-client-id',
			'--client-secret=shh',
		] );

		const removed = await runOAuth2( [
			'auth',
			'remove',
			fixture.baseUrl,
		] );
		expect( removed.exitCode ).toBe( 0 );
		expect( removed.stdout ).toContain(
			'exposes no REST endpoint to revoke it'
		);

		const removedAgain = await runOAuth2( [
			'auth',
			'remove',
			fixture.baseUrl,
		] );
		expect( removedAgain.exitCode ).toBe( 1 );
		expect( removedAgain.stderr ).toContain(
			'No stored OAuth2 credential for'
		);
	} );
} );
