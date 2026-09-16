/**
 * External dependencies
 */
import { describe, expect, it, jest } from '@jest/globals';

/**
 * Internal dependencies
 */
import {
	introspectApplicationPassword,
	revokeApplicationPassword,
} from '../../src/core/auth/application-passwords.js';
import type { WpRestClient } from '../../src/core/client.js';

const API_ROOT = 'https://example.com/wp-json/';

describe( 'introspectApplicationPassword', () => {
	it( 'maps a successful snake_case response onto the camelCase interface', async () => {
		const client = {
			request: async () => ( {
				status: 200,
				headers: new Headers(),
				body: {
					uuid: 'abcd-1234',
					app_id: 'app-id-value',
					name: 'wp-rest-cli',
					created: 1700000000,
					last_used: 1700000100,
					last_ip: '127.0.0.1',
				},
			} ),
		} as unknown as WpRestClient;

		await expect(
			introspectApplicationPassword( client, API_ROOT )
		).resolves.toEqual( {
			uuid: 'abcd-1234',
			appId: 'app-id-value',
			name: 'wp-rest-cli',
			created: 1700000000,
			lastUsed: 1700000100,
			lastIp: '127.0.0.1',
		} );
	} );

	it( 'resolves to undefined, not a rejection, when the request throws', async () => {
		const client = {
			request: async () => {
				throw new Error( 'not an application password' );
			},
		} as unknown as WpRestClient;

		await expect(
			introspectApplicationPassword( client, API_ROOT )
		).resolves.toBeUndefined();
	} );

	it( 'requests the introspect URL resolved against the API root', async () => {
		const request = jest.fn(
			async ( _url: string, _options?: unknown ) => ( {
				status: 200,
				headers: new Headers(),
				body: {
					uuid: 'abcd-1234',
					app_id: null,
					name: 'wp-rest-cli',
					created: 1700000000,
					last_used: null,
					last_ip: null,
				},
			} )
		);
		const client = { request } as unknown as WpRestClient;

		await introspectApplicationPassword( client, API_ROOT );

		expect( request ).toHaveBeenCalledWith(
			'https://example.com/wp-json/wp/v2/users/me/application-passwords/introspect',
			expect.objectContaining( { timeoutMs: 8000 } )
		);
	} );
} );

describe( 'revokeApplicationPassword', () => {
	it( 'resolves to true on success', async () => {
		const client = {
			request: async () => ( {
				status: 200,
				headers: new Headers(),
				body: undefined,
			} ),
		} as unknown as WpRestClient;

		await expect(
			revokeApplicationPassword( client, API_ROOT, 'abcd-1234' )
		).resolves.toBe( true );
	} );

	it( 'resolves to false, not a rejection, when the request throws', async () => {
		const client = {
			request: async () => {
				throw new Error( 'network error' );
			},
		} as unknown as WpRestClient;

		await expect(
			revokeApplicationPassword( client, API_ROOT, 'abcd-1234' )
		).resolves.toBe( false );
	} );

	it( 'DELETEs the single-uuid route, never the bulk route', async () => {
		const request = jest.fn(
			async ( _url: string, _options?: unknown ) => ( {
				status: 200,
				headers: new Headers(),
				body: undefined,
			} )
		);
		const client = { request } as unknown as WpRestClient;

		await revokeApplicationPassword( client, API_ROOT, 'abcd-1234' );

		expect( request ).toHaveBeenCalledWith(
			'https://example.com/wp-json/wp/v2/users/me/application-passwords/abcd-1234',
			expect.objectContaining( { method: 'DELETE', timeoutMs: 8000 } )
		);
	} );

	it( 'encodeURIComponent-escapes a uuid containing characters that need escaping', async () => {
		const request = jest.fn(
			async ( _url: string, _options?: unknown ) => ( {
				status: 200,
				headers: new Headers(),
				body: undefined,
			} )
		);
		const client = { request } as unknown as WpRestClient;

		await revokeApplicationPassword( client, API_ROOT, 'has space/slash' );

		expect( request ).toHaveBeenCalledWith(
			`https://example.com/wp-json/wp/v2/users/me/application-passwords/${ encodeURIComponent(
				'has space/slash'
			) }`,
			expect.objectContaining( { method: 'DELETE' } )
		);
	} );
} );
