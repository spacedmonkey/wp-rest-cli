/**
 * External dependencies
 */
import { describe, expect, it } from '@jest/globals';

/**
 * Internal dependencies
 */
import { parseAuthArgs } from '../../src/commands/auth.js';
import { CliError } from '../../src/core/errors.js';

const TYPE = 'application-passwords';

describe( 'parseAuthArgs', () => {
	describe( 'type validation', () => {
		it( 'throws a general usage error when no type is given at all', () => {
			expect( () => parseAuthArgs( [] ) ).toThrow( CliError );
			expect( () => parseAuthArgs( [] ) ).toThrow( 'Usage: wp auth' );
		} );

		it( 'throws a general usage error for a completely unrecognized type', () => {
			expect( () => parseAuthArgs( [ 'bogus', 'login' ] ) ).toThrow(
				CliError
			);
			expect( () => parseAuthArgs( [ 'bogus', 'login' ] ) ).toThrow(
				'Usage: wp auth'
			);
		} );

		it( 'throws a specific migration hint when a bare verb is given where the type belongs (the old grammar)', () => {
			expect( () =>
				parseAuthArgs( [ 'login', 'https://example.com' ] )
			).toThrow( 'is the old syntax' );
			expect( () => parseAuthArgs( [ 'status' ] ) ).toThrow(
				'wp auth application-passwords status'
			);
		} );
	} );

	describe( 'login', () => {
		it( 'parses a bare url with the default app name', () => {
			expect(
				parseAuthArgs( [ TYPE, 'login', 'https://example.com' ] )
			).toEqual( {
				authType: TYPE,
				mode: 'login',
				url: 'https://example.com',
				appName: 'wp-rest-cli',
			} );
		} );

		it( 'parses an app-name= override', () => {
			expect(
				parseAuthArgs( [
					TYPE,
					'login',
					'https://example.com',
					'app-name=my-app',
				] )
			).toEqual( {
				authType: TYPE,
				mode: 'login',
				url: 'https://example.com',
				appName: 'my-app',
			} );
		} );

		it( 'honors an explicit empty app-name= rather than silently defaulting', () => {
			expect(
				parseAuthArgs( [
					TYPE,
					'login',
					'https://example.com',
					'app-name=',
				] )
			).toEqual( {
				authType: TYPE,
				mode: 'login',
				url: 'https://example.com',
				appName: '',
			} );
		} );

		it( 'accepts a url containing its own = (a query string), not mistaking it for a field', () => {
			expect(
				parseAuthArgs( [
					TYPE,
					'login',
					'https://example.com/?rest_route=/',
				] )
			).toEqual( {
				authType: TYPE,
				mode: 'login',
				url: 'https://example.com/?rest_route=/',
				appName: 'wp-rest-cli',
			} );
		} );

		it( 'throws when no url is given', () => {
			expect( () => parseAuthArgs( [ TYPE, 'login' ] ) ).toThrow(
				CliError
			);
		} );

		it( 'throws when a field-shaped token is given where the url belongs', () => {
			expect( () =>
				parseAuthArgs( [ TYPE, 'login', 'app-name=my-app' ] )
			).toThrow( CliError );
		} );
	} );

	describe( 'add', () => {
		it( 'parses a bare url with skipVerify false', () => {
			expect(
				parseAuthArgs( [ TYPE, 'add', 'https://example.com' ] )
			).toEqual( {
				authType: TYPE,
				mode: 'add',
				url: 'https://example.com',
				skipVerify: false,
			} );
		} );

		it( 'parses skip-verify=true', () => {
			expect(
				parseAuthArgs( [
					TYPE,
					'add',
					'https://example.com',
					'skip-verify=true',
				] )
			).toEqual( {
				authType: TYPE,
				mode: 'add',
				url: 'https://example.com',
				skipVerify: true,
			} );
		} );

		it( 'accepts a url containing its own = (a query string)', () => {
			expect(
				parseAuthArgs( [ TYPE, 'add', 'https://example.com/?x=1' ] )
			).toEqual( {
				authType: TYPE,
				mode: 'add',
				url: 'https://example.com/?x=1',
				skipVerify: false,
			} );
		} );

		it( 'throws when no url is given', () => {
			expect( () => parseAuthArgs( [ TYPE, 'add' ] ) ).toThrow(
				CliError
			);
		} );

		it( 'throws when a field-shaped token is given where the url belongs', () => {
			expect( () =>
				parseAuthArgs( [ TYPE, 'add', 'skip-verify=true' ] )
			).toThrow( CliError );
		} );
	} );

	describe( 'list', () => {
		it( 'parses with no arguments', () => {
			expect( parseAuthArgs( [ TYPE, 'list' ] ) ).toEqual( {
				authType: TYPE,
				mode: 'list',
			} );
		} );
	} );

	describe( 'remove', () => {
		it( 'parses a bare url', () => {
			expect(
				parseAuthArgs( [ TYPE, 'remove', 'https://example.com' ] )
			).toEqual( {
				authType: TYPE,
				mode: 'remove',
				url: 'https://example.com',
			} );
		} );

		it( 'accepts a url containing its own = (a query string)', () => {
			expect(
				parseAuthArgs( [ TYPE, 'remove', 'https://example.com/?x=1' ] )
			).toEqual( {
				authType: TYPE,
				mode: 'remove',
				url: 'https://example.com/?x=1',
			} );
		} );

		it( 'parses --all as remove-all', () => {
			expect( parseAuthArgs( [ TYPE, 'remove', 'all=true' ] ) ).toEqual( {
				authType: TYPE,
				mode: 'remove-all',
			} );
		} );

		it( 'throws when neither a url nor --all is given', () => {
			expect( () => parseAuthArgs( [ TYPE, 'remove' ] ) ).toThrow(
				CliError
			);
		} );

		it( 'throws when both a url and --all are given', () => {
			expect( () =>
				parseAuthArgs( [
					TYPE,
					'remove',
					'https://example.com',
					'all=true',
				] )
			).toThrow( CliError );
		} );

		it( 'treats a token with an unrecognized field name as the url, not a malformed field — there is no reliable way to tell those apart, and a url winning is the safer default', () => {
			expect( parseAuthArgs( [ TYPE, 'remove', 'bogus=true' ] ) ).toEqual(
				{ authType: TYPE, mode: 'remove', url: 'bogus=true' }
			);
		} );
	} );

	describe( 'use', () => {
		it( 'parses a url', () => {
			expect(
				parseAuthArgs( [ TYPE, 'use', 'https://example.com' ] )
			).toEqual( {
				authType: TYPE,
				mode: 'use',
				url: 'https://example.com',
			} );
		} );

		it( 'throws when no url is given', () => {
			expect( () => parseAuthArgs( [ TYPE, 'use' ] ) ).toThrow(
				CliError
			);
		} );
	} );

	describe( 'status', () => {
		it( 'parses with no arguments', () => {
			expect( parseAuthArgs( [ TYPE, 'status' ] ) ).toEqual( {
				authType: TYPE,
				mode: 'status',
			} );
		} );
	} );

	it( 'throws on an unrecognized subcommand', () => {
		expect( () => parseAuthArgs( [ TYPE, 'bogus' ] ) ).toThrow( CliError );
	} );

	it( 'throws when a type is given but no subcommand at all', () => {
		expect( () => parseAuthArgs( [ TYPE ] ) ).toThrow( CliError );
	} );
} );

describe( 'parseAuthArgs: oauth2', () => {
	const OAUTH2_TYPE = 'oauth2';

	describe( 'login', () => {
		// client-id=/client-secret= are no longer parsed here at all — the
		// real --client-id/--client-secret flags are read from GlobalFlags at
		// handler-execution time instead (see handleLogin in
		// commands/auth/oauth2.ts), the same way application-passwords reads
		// --username/--password. parseAuthArgs only ever sees the tokens
		// following `login`, which no longer include the credential.
		it( 'parses a bare url', () => {
			expect(
				parseAuthArgs( [ OAUTH2_TYPE, 'login', 'https://example.com' ] )
			).toEqual( {
				authType: OAUTH2_TYPE,
				mode: 'login',
				url: 'https://example.com',
				redirectUri: undefined,
				port: undefined,
			} );
		} );

		it( 'parses an optional redirect-uri= field on its own (already carries its own port)', () => {
			expect(
				parseAuthArgs( [
					OAUTH2_TYPE,
					'login',
					'https://example.com',
					'redirect-uri=http://127.0.0.1:9999/callback',
				] )
			).toEqual( {
				authType: OAUTH2_TYPE,
				mode: 'login',
				url: 'https://example.com',
				redirectUri: 'http://127.0.0.1:9999/callback',
				port: undefined,
			} );
		} );

		it( 'parses an optional port= field on its own', () => {
			expect(
				parseAuthArgs( [
					OAUTH2_TYPE,
					'login',
					'https://example.com',
					'port=9999',
				] )
			).toEqual( {
				authType: OAUTH2_TYPE,
				mode: 'login',
				url: 'https://example.com',
				redirectUri: undefined,
				port: 9999,
			} );
		} );

		it( 'throws when no url is given', () => {
			expect( () => parseAuthArgs( [ OAUTH2_TYPE, 'login' ] ) ).toThrow(
				CliError
			);
		} );

		it( 'throws when port= is not a valid port number', () => {
			expect( () =>
				parseAuthArgs( [
					OAUTH2_TYPE,
					'login',
					'https://example.com',
					'port=not-a-number',
				] )
			).toThrow( CliError );
		} );

		it( 'throws when both redirect-uri= and port= are given, rather than silently preferring one', () => {
			expect( () =>
				parseAuthArgs( [
					OAUTH2_TYPE,
					'login',
					'https://example.com',
					'redirect-uri=http://127.0.0.1:9999/callback',
					'port=9999',
				] )
			).toThrow( 'pass either redirect-uri= ' );
		} );

		it( 'throws a migration hint when the old client-id= field syntax is used where the url belongs', () => {
			expect( () =>
				parseAuthArgs( [ OAUTH2_TYPE, 'login', 'client-id=abc123' ] )
			).toThrow( CliError );
		} );

		it( 'throws a migration hint when the old client-id=/client-secret= field syntax is used after a valid url', () => {
			expect( () =>
				parseAuthArgs( [
					OAUTH2_TYPE,
					'login',
					'https://example.com',
					'client-id=abc123',
				] )
			).toThrow( '--client-id=' );
			expect( () =>
				parseAuthArgs( [
					OAUTH2_TYPE,
					'login',
					'https://example.com',
					'client-secret=shh',
				] )
			).toThrow( '--client-secret=' );
		} );
	} );

	describe( 'add', () => {
		// Same rationale as login above — client-id=/client-secret= are no
		// longer parsed here; --client-id/--client-secret are read from
		// GlobalFlags at handler-execution time instead.
		it( 'parses a bare url', () => {
			expect(
				parseAuthArgs( [ OAUTH2_TYPE, 'add', 'https://example.com' ] )
			).toEqual( {
				authType: OAUTH2_TYPE,
				mode: 'add',
				url: 'https://example.com',
				skipVerify: false,
			} );
		} );

		// --token= (a personal access token, an alternative to
		// --client-id/--client-secret) is read from GlobalFlags at
		// handler-execution time too, the same as --client-id/--client-secret
		// — only its own skip-verify= field is parsed here.
		it( 'parses an optional skip-verify= field', () => {
			expect(
				parseAuthArgs( [
					OAUTH2_TYPE,
					'add',
					'https://example.com',
					'skip-verify=true',
				] )
			).toEqual( {
				authType: OAUTH2_TYPE,
				mode: 'add',
				url: 'https://example.com',
				skipVerify: true,
			} );
		} );

		it( 'throws when no url is given', () => {
			expect( () => parseAuthArgs( [ OAUTH2_TYPE, 'add' ] ) ).toThrow(
				CliError
			);
		} );

		it( 'throws a migration hint when the old client-id= field syntax is used where the url belongs', () => {
			expect( () =>
				parseAuthArgs( [ OAUTH2_TYPE, 'add', 'client-id=abc123' ] )
			).toThrow( CliError );
		} );

		it( 'throws a migration hint when the old client-id=/client-secret= field syntax is used after a valid url', () => {
			expect( () =>
				parseAuthArgs( [
					OAUTH2_TYPE,
					'add',
					'https://example.com',
					'client-id=abc123',
					'client-secret=shh',
				] )
			).toThrow( '--client-id=' );
		} );

		it( 'throws the migration hint even when skip-verify= is also given', () => {
			expect( () =>
				parseAuthArgs( [
					OAUTH2_TYPE,
					'add',
					'https://example.com',
					'client-id=abc123',
					'skip-verify=true',
				] )
			).toThrow( '--client-id=' );
		} );
	} );

	describe( 'list/remove/remove-all/use/status', () => {
		it( 'parses list with no arguments', () => {
			expect( parseAuthArgs( [ OAUTH2_TYPE, 'list' ] ) ).toEqual( {
				authType: OAUTH2_TYPE,
				mode: 'list',
			} );
		} );

		it( 'parses a remove url', () => {
			expect(
				parseAuthArgs( [
					OAUTH2_TYPE,
					'remove',
					'https://example.com',
				] )
			).toEqual( {
				authType: OAUTH2_TYPE,
				mode: 'remove',
				url: 'https://example.com',
			} );
		} );

		it( 'parses --all as remove-all', () => {
			expect(
				parseAuthArgs( [ OAUTH2_TYPE, 'remove', 'all=true' ] )
			).toEqual( {
				authType: OAUTH2_TYPE,
				mode: 'remove-all',
			} );
		} );

		it( 'parses a use url', () => {
			expect(
				parseAuthArgs( [ OAUTH2_TYPE, 'use', 'https://example.com' ] )
			).toEqual( {
				authType: OAUTH2_TYPE,
				mode: 'use',
				url: 'https://example.com',
			} );
		} );

		it( 'parses status with no arguments', () => {
			expect( parseAuthArgs( [ OAUTH2_TYPE, 'status' ] ) ).toEqual( {
				authType: OAUTH2_TYPE,
				mode: 'status',
			} );
		} );
	} );
} );

describe( 'parseAuthArgs: <url> falls back to defaultUrl (the --url flag/saved default)', () => {
	const APP_PASSWORDS_TYPE = 'application-passwords';
	const OAUTH2_TYPE = 'oauth2';
	const DEFAULT_URL = 'https://default.example.com';

	it( 'login uses defaultUrl when no positional url is given (application-passwords)', () => {
		expect(
			parseAuthArgs( [ APP_PASSWORDS_TYPE, 'login' ], DEFAULT_URL )
		).toEqual( {
			authType: APP_PASSWORDS_TYPE,
			mode: 'login',
			url: DEFAULT_URL,
			appName: 'wp-rest-cli',
		} );
	} );

	it( 'login uses defaultUrl when the first token is a field, not a url (oauth2)', () => {
		expect(
			parseAuthArgs( [ OAUTH2_TYPE, 'login', 'port=9999' ], DEFAULT_URL )
		).toEqual( {
			authType: OAUTH2_TYPE,
			mode: 'login',
			url: DEFAULT_URL,
			redirectUri: undefined,
			port: 9999,
		} );
	} );

	it( 'an explicit positional url still wins over defaultUrl', () => {
		expect(
			parseAuthArgs(
				[ APP_PASSWORDS_TYPE, 'login', 'https://explicit.example.com' ],
				DEFAULT_URL
			)
		).toEqual( {
			authType: APP_PASSWORDS_TYPE,
			mode: 'login',
			url: 'https://explicit.example.com',
			appName: 'wp-rest-cli',
		} );
	} );

	it( 'add uses defaultUrl when no positional url is given (oauth2)', () => {
		expect( parseAuthArgs( [ OAUTH2_TYPE, 'add' ], DEFAULT_URL ) ).toEqual(
			{
				authType: OAUTH2_TYPE,
				mode: 'add',
				url: DEFAULT_URL,
				skipVerify: false,
			}
		);
	} );

	it( 'remove uses defaultUrl when no positional url is given', () => {
		expect(
			parseAuthArgs( [ APP_PASSWORDS_TYPE, 'remove' ], DEFAULT_URL )
		).toEqual( {
			authType: APP_PASSWORDS_TYPE,
			mode: 'remove',
			url: DEFAULT_URL,
		} );
	} );

	it( 'remove --all still works with a defaultUrl available (remove-all takes no url at all)', () => {
		expect(
			parseAuthArgs(
				[ APP_PASSWORDS_TYPE, 'remove', 'all=true' ],
				DEFAULT_URL
			)
		).toEqual( { authType: APP_PASSWORDS_TYPE, mode: 'remove-all' } );
	} );

	it( 'remove still rejects an explicit url combined with --all, even with a defaultUrl available', () => {
		expect( () =>
			parseAuthArgs(
				[
					APP_PASSWORDS_TYPE,
					'remove',
					'https://explicit.example.com',
					'all=true',
				],
				DEFAULT_URL
			)
		).toThrow( 'pass either <url> or --all, not both' );
	} );

	it( 'use uses defaultUrl when no positional url is given', () => {
		expect( parseAuthArgs( [ OAUTH2_TYPE, 'use' ], DEFAULT_URL ) ).toEqual(
			{
				authType: OAUTH2_TYPE,
				mode: 'use',
				url: DEFAULT_URL,
			}
		);
	} );

	it( 'throws with a "pass <url> or set --url" hint when neither is available', () => {
		expect( () => parseAuthArgs( [ OAUTH2_TYPE, 'login' ] ) ).toThrow(
			'--url='
		);
	} );

	it( 'still prioritizes the client-id=/client-secret= migration-hint error over the missing-url error', () => {
		// Even with no defaultUrl at all, the more specific/actionable error
		// wins — see the note in parseLoginArgs about checking this first.
		expect( () =>
			parseAuthArgs( [ OAUTH2_TYPE, 'login', 'client-id=abc123' ] )
		).toThrow( '--client-id=' );
	} );
} );
