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

		it( 'throws a specific "planned but not implemented" error for a reserved type', () => {
			expect( () =>
				parseAuthArgs( [ 'oauth2', 'login', 'https://example.com' ] )
			).toThrow( 'planned but not yet implemented' );
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
