/**
 * External dependencies
 */
import { describe, expect, it, jest } from '@jest/globals';

/**
 * Internal dependencies
 */
import {
	assertOAuth2Supported,
	OAuth2AuthProvider,
	resolveRedirectUriPort,
	runOAuth2AuthorizationCodeFlow,
} from '../../src/core/auth/oauth2.js';
import type { WpRestClient } from '../../src/core/client.js';
import { CliError } from '../../src/core/errors.js';
import {
	getOAuth2Endpoints,
	isOAuth2Supported,
} from '../../src/core/indexer.js';
import type { IndexResponse } from '../../src/types.js';

/**
 * A minimal stand-in for `WpRestClient` whose `request` method is a spy, so
 * tests can assert exactly how many (if any) requests a code path issued —
 * Jest's ESM setup here can't hoist `jest.mock()` module replacement, so this
 * duck-typed fake (cast to `WpRestClient`) is used instead of mocking the
 * `client.js` module.
 * @param response The value `request()` should resolve its `body` to.
 * @return The fake client and its underlying request spy.
 */
function fakeClient( response: unknown ): {
	client: WpRestClient;
	request: jest.Mock;
} {
	const request = jest.fn( async () => ( {
		status: 200,
		headers: new Headers(),
		body: response,
	} ) );
	return { client: { request } as unknown as WpRestClient, request };
}

const baseIndex: IndexResponse = {
	namespaces: [],
	routes: {},
};

describe( 'OAuth2AuthProvider', () => {
	it( 'returns a Bearer authorization header for the configured token', async () => {
		const provider = new OAuth2AuthProvider( 'abc123' );
		expect( await provider.getHeaders() ).toEqual( {
			Authorization: 'Bearer abc123',
		} );
	} );
} );

describe( 'isOAuth2Supported / getOAuth2Endpoints', () => {
	it( 'reports unsupported when the authentication.oauth2 block is absent entirely', () => {
		expect( isOAuth2Supported( baseIndex ) ).toBe( false );
		expect( getOAuth2Endpoints( baseIndex ) ).toBeUndefined();
	} );

	it( 'reports unsupported when only the authorization endpoint is present (no token endpoint)', () => {
		const index: IndexResponse = {
			...baseIndex,
			authentication: {
				oauth2: {
					endpoints: {
						authorization: 'https://example.com/oauth2-authorize',
					},
				},
			},
		};
		expect( isOAuth2Supported( index ) ).toBe( false );
		expect( getOAuth2Endpoints( index ) ).toBeUndefined();
	} );

	it( 'reports supported when only the token endpoint is present — needed for client_credentials-only setups', () => {
		const index: IndexResponse = {
			...baseIndex,
			authentication: {
				oauth2: {
					endpoints: {
						token: 'https://example.com/wp-json/oauth2/access_token',
					},
				},
			},
		};
		expect( isOAuth2Supported( index ) ).toBe( true );
		expect( getOAuth2Endpoints( index ) ).toEqual( {
			token: 'https://example.com/wp-json/oauth2/access_token',
		} );
	} );

	it( 'reports supported when both endpoints are present', () => {
		const index: IndexResponse = {
			...baseIndex,
			authentication: {
				oauth2: {
					endpoints: {
						authorization: 'https://example.com/oauth2-authorize',
						token: 'https://example.com/wp-json/oauth2/access_token',
					},
					grant_types: [ 'authorization_code', 'implicit' ],
				},
			},
		};
		expect( isOAuth2Supported( index ) ).toBe( true );
		expect( getOAuth2Endpoints( index ) ).toEqual( {
			authorization: 'https://example.com/oauth2-authorize',
			token: 'https://example.com/wp-json/oauth2/access_token',
		} );
	} );

	it( 'reports supported even when grant_types omits client_credentials — the plugin never lists it there, even when it is fully enabled', () => {
		const index: IndexResponse = {
			...baseIndex,
			authentication: {
				oauth2: {
					endpoints: {
						authorization: 'https://example.com/oauth2-authorize',
						token: 'https://example.com/wp-json/oauth2/access_token',
					},
					// Deliberately omits 'client_credentials', matching the real
					// plugin's register_in_index() behavior.
					grant_types: [ 'authorization_code', 'implicit' ],
				},
			},
		};
		expect( isOAuth2Supported( index ) ).toBe( true );
	} );
} );

describe( 'assertOAuth2Supported', () => {
	it( 'rejects with a CliError, without calling the client at all, for a plain-HTTP non-loopback apiRoot', async () => {
		const { client, request } = fakeClient( baseIndex );
		await expect(
			assertOAuth2Supported( client, 'http://example.com/wp-json' )
		).rejects.toThrow( CliError );
		expect( request ).not.toHaveBeenCalled();
	} );

	it( 'allows plain HTTP on a loopback host', async () => {
		const index: IndexResponse = {
			...baseIndex,
			authentication: {
				oauth2: {
					endpoints: {
						token: 'http://127.0.0.1/wp-json/oauth2/access_token',
					},
				},
			},
		};
		const { client } = fakeClient( index );
		await expect(
			assertOAuth2Supported( client, 'http://127.0.0.1/wp-json' )
		).resolves.toEqual( {
			token: 'http://127.0.0.1/wp-json/oauth2/access_token',
		} );
	} );

	it( 'rejects with a CliError, after exactly one client call (fetchIndex), when the site does not advertise oauth2 support', async () => {
		const { client, request } = fakeClient( baseIndex );
		await expect(
			assertOAuth2Supported( client, 'https://example.com/wp-json' )
		).rejects.toThrow( CliError );
		expect( request ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'resolves with the endpoints when the site advertises oauth2 support', async () => {
		const index: IndexResponse = {
			...baseIndex,
			authentication: {
				oauth2: {
					endpoints: {
						authorization: 'https://example.com/oauth2-authorize',
						token: 'https://example.com/wp-json/oauth2/access_token',
					},
				},
			},
		};
		const { client, request } = fakeClient( index );
		await expect(
			assertOAuth2Supported( client, 'https://example.com/wp-json' )
		).resolves.toEqual( {
			authorization: 'https://example.com/oauth2-authorize',
			token: 'https://example.com/wp-json/oauth2/access_token',
		} );
		expect( request ).toHaveBeenCalledTimes( 1 );
	} );
} );

describe( 'resolveRedirectUriPort', () => {
	it( 'reads an explicit non-default port', () => {
		expect(
			resolveRedirectUriPort(
				new URL( 'http://127.0.0.1:8787/callback' )
			)
		).toBe( 8787 );
	} );

	it( "resolves http's default port (80) when none is given", () => {
		expect(
			resolveRedirectUriPort( new URL( 'http://127.0.0.1/callback' ) )
		).toBe( 80 );
	} );

	it( "resolves https's default port (443) when none is given", () => {
		expect(
			resolveRedirectUriPort( new URL( 'https://127.0.0.1/callback' ) )
		).toBe( 443 );
	} );

	it( 'resolves an EXPLICIT default port (e.g. :80) the same as an implicit one — the WHATWG URL parser blanks .port either way', () => {
		// This is the exact case a naive `Number(url.port)` check gets wrong:
		// `new URL('http://127.0.0.1:80/callback').port` is `''`, identical
		// to the fully-omitted-port case above, even though the caller did
		// write an explicit port.
		expect(
			resolveRedirectUriPort( new URL( 'http://127.0.0.1:80/callback' ) )
		).toBe( 80 );
		expect(
			resolveRedirectUriPort(
				new URL( 'https://127.0.0.1:443/callback' )
			)
		).toBe( 443 );
	} );

	it( 'returns undefined for a scheme with no known default port', () => {
		expect(
			resolveRedirectUriPort( new URL( 'ftp://127.0.0.1/callback' ) )
		).toBeUndefined();
	} );
} );

describe( 'runOAuth2AuthorizationCodeFlow', () => {
	it( 'rejects a redirect-uri whose scheme has no resolvable port, without calling the client at all', async () => {
		const { client, request } = fakeClient( baseIndex );
		await expect(
			runOAuth2AuthorizationCodeFlow(
				client,
				'https://example.com/wp-json',
				'client-id',
				undefined,
				'ftp://127.0.0.1/callback'
			)
		).rejects.toThrow( 'must be an http:// or https:// URL' );
		expect( request ).not.toHaveBeenCalled();
	} );
} );
