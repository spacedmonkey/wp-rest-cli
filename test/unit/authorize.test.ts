/**
 * External dependencies
 */
import { describe, expect, it } from '@jest/globals';

/**
 * Internal dependencies
 */
import {
	authorizePrompt,
	buildAuthorizationUrl,
	canSiteUseApplicationPasswords,
	runAuthorizationFlow,
} from '../../src/core/auth/authorize.js';
import type { WpRestClient } from '../../src/core/client.js';
import { CliError } from '../../src/core/errors.js';
import type { IndexResponse } from '../../src/types.js';

/**
 * A minimal stand-in for `WpRestClient` that always answers `fetchIndex`'s
 * single GET with the given index, regardless of the requested URL.
 * @param index The index response to return.
 * @return An object shaped enough to satisfy `fetchIndex`'s use of the client.
 */
function fakeIndexClient( index: IndexResponse ): WpRestClient {
	return {
		request: async () => ( {
			status: 200,
			headers: new Headers(),
			body: index,
		} ),
	} as unknown as WpRestClient;
}

const NO_AUTH_INDEX: IndexResponse = { namespaces: [], routes: {} };

describe( 'buildAuthorizationUrl', () => {
	it( 'resolves a site-relative authorization endpoint against the API root', () => {
		const url = buildAuthorizationUrl(
			'https://example.com/wp-json/',
			'/wp-admin/authorize-application.php',
			'wrapido',
			'http://127.0.0.1:4567/callback'
		);
		const parsed = new URL( url );
		expect( parsed.origin + parsed.pathname ).toBe(
			'https://example.com/wp-admin/authorize-application.php'
		);
		expect( parsed.searchParams.get( 'app_name' ) ).toBe( 'wrapido' );
		expect( parsed.searchParams.get( 'success_url' ) ).toBe(
			'http://127.0.0.1:4567/callback'
		);
	} );

	it( 'keeps an already-absolute authorization endpoint pointed at its own host', () => {
		const url = buildAuthorizationUrl(
			'https://example.com/wp-json/',
			'https://auth.example.com/wp-admin/authorize-application.php',
			'wrapido',
			'http://127.0.0.1:4567/callback'
		);
		expect( new URL( url ).host ).toBe( 'auth.example.com' );
	} );
} );

describe( 'canSiteUseApplicationPasswords', () => {
	it( 'is true for an HTTPS site', () => {
		expect(
			canSiteUseApplicationPasswords( 'https://example.com/wp-json/' )
		).toBe( true );
	} );

	it( 'is false for a plain-HTTP, non-loopback site', () => {
		expect(
			canSiteUseApplicationPasswords( 'http://example.com/wp-json/' )
		).toBe( false );
	} );

	it( 'is true for plain-HTTP localhost', () => {
		expect(
			canSiteUseApplicationPasswords( 'http://localhost:8080/wp-json/' )
		).toBe( true );
	} );

	it( 'is true for plain-HTTP 127.0.0.1', () => {
		expect(
			canSiteUseApplicationPasswords( 'http://127.0.0.1:8080/wp-json/' )
		).toBe( true );
	} );

	it( 'is true for plain-HTTP [::1]', () => {
		expect(
			canSiteUseApplicationPasswords( 'http://[::1]:8080/wp-json/' )
		).toBe( true );
	} );
} );

describe( 'runAuthorizationFlow', () => {
	it( 'rejects with the HTTP-specific hint for a plain-HTTP, non-localhost site', async () => {
		const flow = runAuthorizationFlow(
			fakeIndexClient( NO_AUTH_INDEX ),
			'http://example.com/wp-json/',
			'wrapido',
			() => {}
		);
		await expect( flow ).rejects.toBeInstanceOf( CliError );
		await expect( flow ).rejects.toThrow(
			'disables Application Passwords over plain HTTP'
		);
	} );

	it( 'rejects with the generic hint for an HTTPS site that just does not support it', async () => {
		const flow = runAuthorizationFlow(
			fakeIndexClient( NO_AUTH_INDEX ),
			'https://example.com/wp-json/',
			'wrapido',
			() => {}
		);
		await expect( flow ).rejects.toBeInstanceOf( CliError );
		await expect( flow ).rejects.toThrow( 'requires WordPress 5.6+' );
	} );

	it( 'does not require HTTPS for localhost', async () => {
		const flow = runAuthorizationFlow(
			fakeIndexClient( NO_AUTH_INDEX ),
			'http://localhost:8080/wp-json/',
			'wrapido',
			() => {}
		);
		await expect( flow ).rejects.toThrow( 'requires WordPress 5.6+' );
	} );

	it( 'prints the authorize URL, then resolves once the local callback receives credentials', async () => {
		const index: IndexResponse = {
			namespaces: [],
			routes: {},
			authentication: {
				'application-passwords': {
					endpoints: {
						authorization:
							'https://example.com/wp-admin/authorize-application.php',
					},
				},
			},
		};

		let resolvePrinted: ( line: string ) => void;
		const printed = new Promise< string >( ( resolve ) => {
			resolvePrinted = resolve;
		} );

		const flow = runAuthorizationFlow(
			fakeIndexClient( index ),
			'https://example.com/wp-json/',
			'wrapido',
			( line ) => resolvePrinted( line )
		);

		const line = await printed;
		const [ authorizeUrl ] = line.match(
			/https:\/\/example\.com\/wp-admin\/authorize-application\.php\?[^\s\x1b]+/
		) as RegExpMatchArray;
		const successUrl = new URL( authorizeUrl ).searchParams.get(
			'success_url'
		) as string;

		const callbackResponse = await fetch(
			`${ successUrl }?user_login=testuser&password=abcd-1234-efgh`
		);
		expect( callbackResponse.status ).toBe( 200 );

		await expect( flow ).resolves.toEqual( {
			userLogin: 'testuser',
			password: 'abcd-1234-efgh',
		} );
	} );

	it( 'times out if the browser callback never arrives', async () => {
		const index: IndexResponse = {
			namespaces: [],
			routes: {},
			authentication: {
				'application-passwords': {
					endpoints: {
						authorization:
							'https://example.com/wp-admin/authorize-application.php',
					},
				},
			},
		};

		await expect(
			runAuthorizationFlow(
				fakeIndexClient( index ),
				'https://example.com/wp-json/',
				'wrapido',
				() => {},
				50
			)
		).rejects.toThrow( 'Timed out' );
	} );
} );

describe( 'authorizePrompt', () => {
	const url = 'https://example.com/wp-admin/authorize-application.php?a=b';

	it( 'prints the URL alone on an unindented line', () => {
		const prompt = authorizePrompt( url, false );
		expect( prompt.split( '\n' ) ).toContain( url );
		expect( prompt ).not.toContain( '\x1b' );
	} );

	it( 'wraps the URL in an OSC 8 hyperlink when asked', () => {
		expect( authorizePrompt( url, true ) ).toContain(
			`\x1b]8;;${ url }\x1b\\${ url }\x1b]8;;\x1b\\`
		);
	} );
} );
