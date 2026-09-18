/**
 * External dependencies
 */
import { describe, expect, it } from '@jest/globals';

/**
 * Internal dependencies
 */
import { redactBody, redactHeaders } from '../../src/core/debug.js';

describe( 'redactHeaders', () => {
	it( 'masks the Authorization value but keeps the scheme', () => {
		const redacted = redactHeaders( {
			Authorization: 'Basic YWRtaW46c2VjcmV0',
		} );
		expect( redacted.Authorization ).toBe( 'Basic <redacted>' );
	} );

	it( 'leaves other headers untouched', () => {
		const redacted = redactHeaders( {
			Accept: 'application/json',
			'Content-Type': 'application/json',
		} );
		expect( redacted ).toEqual( {
			Accept: 'application/json',
			'Content-Type': 'application/json',
		} );
	} );

	it( 'is case-insensitive about the header name', () => {
		const redacted = redactHeaders( {
			authorization: 'Basic YWRtaW46c2VjcmV0',
		} );
		expect( redacted.authorization ).toBe( 'Basic <redacted>' );
	} );
} );

describe( 'redactBody', () => {
	it( 'masks sensitive fields in a form-encoded body (e.g. an OAuth2 token exchange)', () => {
		const body = new URLSearchParams( {
			grant_type: 'authorization_code',
			client_id: 'abc123',
			code: 'the-auth-code',
			client_secret: 'shh-secret',
		} ).toString();
		const redacted = redactBody(
			body,
			'application/x-www-form-urlencoded'
		);
		const parsed = new URLSearchParams( redacted );
		expect( parsed.get( 'grant_type' ) ).toBe( 'authorization_code' );
		expect( parsed.get( 'client_id' ) ).toBe( 'abc123' );
		expect( parsed.get( 'code' ) ).toBe( '<redacted>' );
		expect( parsed.get( 'client_secret' ) ).toBe( '<redacted>' );
		expect( redacted ).not.toContain( 'the-auth-code' );
		expect( redacted ).not.toContain( 'shh-secret' );
	} );

	it( 'masks sensitive fields in a JSON body, at any nesting depth', () => {
		const body = JSON.stringify( {
			username: 'admin',
			password: 'super-secret',
			meta: { nested: { access_token: 'nested-token' } },
		} );
		const redacted = JSON.parse(
			redactBody( body, 'application/json' )
		) as Record< string, unknown >;
		expect( redacted.username ).toBe( 'admin' );
		expect( redacted.password ).toBe( '<redacted>' );
		expect(
			( redacted.meta as { nested: { access_token: string } } ).nested
				.access_token
		).toBe( '<redacted>' );
		expect( JSON.stringify( redacted ) ).not.toContain( 'super-secret' );
		expect( JSON.stringify( redacted ) ).not.toContain( 'nested-token' );
	} );

	it( 'returns a non-JSON, non-form body unchanged', () => {
		expect( redactBody( 'not json at all', undefined ) ).toBe(
			'not json at all'
		);
	} );
} );
