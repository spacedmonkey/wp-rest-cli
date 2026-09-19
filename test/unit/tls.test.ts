/**
 * External dependencies
 */
import { afterEach, describe, expect, it, jest } from '@jest/globals';

/**
 * Internal dependencies
 */
import { disableTlsVerification } from '../../src/core/tls.js';

describe( 'disableTlsVerification', () => {
	const originalEmit = process.emitWarning;
	const originalEnv = process.env.NODE_TLS_REJECT_UNAUTHORIZED;

	afterEach( () => {
		process.emitWarning = originalEmit;
		if ( originalEnv === undefined ) {
			delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
		} else {
			process.env.NODE_TLS_REJECT_UNAUTHORIZED = originalEnv;
		}
	} );

	it( 'turns certificate verification off for the process', () => {
		disableTlsVerification();
		expect( process.env.NODE_TLS_REJECT_UNAUTHORIZED ).toBe( '0' );
	} );

	it( "drops Node's insecure-TLS warning but lets other warnings through", () => {
		const inner = jest.fn();
		process.emitWarning = inner as unknown as typeof process.emitWarning;
		disableTlsVerification();

		process.emitWarning(
			"Setting the NODE_TLS_REJECT_UNAUTHORIZED environment variable to '0' makes TLS insecure."
		);
		expect( inner ).not.toHaveBeenCalled();

		process.emitWarning( 'something else', 'DeprecationWarning' );
		expect( inner ).toHaveBeenCalledWith(
			'something else',
			'DeprecationWarning'
		);
	} );
} );
