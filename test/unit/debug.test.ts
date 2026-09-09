/**
 * External dependencies
 */
import { describe, expect, it } from '@jest/globals';

/**
 * Internal dependencies
 */
import { redactHeaders } from '../../src/core/debug.js';

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
