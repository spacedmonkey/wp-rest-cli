/**
 * External dependencies
 */
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	jest,
} from '@jest/globals';

/**
 * Internal dependencies
 */
import {
	resolveTimeout,
	setUserTimeout,
	timedFetch,
} from '../../src/core/timeout.js';

afterEach( () => setUserTimeout( undefined ) );

describe( 'resolveTimeout', () => {
	it( 'uses the request default when --timeout was not given', () => {
		expect( resolveTimeout( 20_000 ) ).toBe( 20_000 );
	} );

	it( "lets the user's --timeout override any default", () => {
		setUserTimeout( 1500 );
		expect( resolveTimeout( 20_000 ) ).toBe( 1500 );
		expect( resolveTimeout( 8000 ) ).toBe( 1500 );
	} );
} );

describe( 'timedFetch', () => {
	let spy: ReturnType< typeof jest.spyOn >;
	let timeoutSpy: ReturnType< typeof jest.spyOn >;

	beforeEach( () => {
		spy = jest
			.spyOn( globalThis, 'fetch' )
			.mockResolvedValue( new Response( 'ok' ) );
		timeoutSpy = jest.spyOn( AbortSignal, 'timeout' );
	} );

	afterEach( () => {
		spy.mockRestore();
		timeoutSpy.mockRestore();
	} );

	it( 'adds a timeout signal using the request default', async () => {
		await timedFetch( 'https://example.com', {}, 8000 );
		expect( timeoutSpy ).toHaveBeenCalledWith( 8000 );
		const init = spy.mock.calls[ 0 ]?.[ 1 ] as RequestInit;
		expect( init.signal ).toBeInstanceOf( AbortSignal );
	} );

	it( "uses the user's --timeout instead of the default", async () => {
		setUserTimeout( 1234 );
		await timedFetch( 'https://example.com', {}, 8000 );
		expect( timeoutSpy ).toHaveBeenCalledWith( 1234 );
	} );

	it( 'respects a caller-supplied signal and passes other options through', async () => {
		const controller = new AbortController();
		await timedFetch(
			'https://example.com',
			{ method: 'HEAD', signal: controller.signal },
			8000
		);
		expect( timeoutSpy ).not.toHaveBeenCalled();
		const init = spy.mock.calls[ 0 ]?.[ 1 ] as RequestInit;
		expect( init.signal ).toBe( controller.signal );
		expect( init.method ).toBe( 'HEAD' );
	} );
} );
