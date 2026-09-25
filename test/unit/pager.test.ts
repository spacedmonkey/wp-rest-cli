/**
 * External dependencies
 */
import { describe, expect, it } from '@jest/globals';

/**
 * Internal dependencies
 */
import { resolvePagerCommand, shouldUsePager } from '../../src/core/pager.js';
import type { GlobalFlags } from '../../src/types.js';

const flags = ( over: Partial< GlobalFlags > = {} ): GlobalFlags => ( {
	context: 'view',
	format: 'table',
	color: true,
	pager: true,
	quiet: false,
	debug: false,
	...over,
} );

describe( 'shouldUsePager', () => {
	it( 'is on by default on a TTY, outside agent mode', () => {
		expect( shouldUsePager( flags(), true, false ) ).toBe( true );
	} );

	it( 'is off when stdout is not a TTY, regardless of flags', () => {
		expect( shouldUsePager( flags(), false, false ) ).toBe( false );
	} );

	it( 'is off under agent mode even on a TTY', () => {
		expect( shouldUsePager( flags(), true, true ) ).toBe( false );
	} );

	it( 'is off when --quiet was passed', () => {
		expect( shouldUsePager( flags( { quiet: true } ), true, false ) ).toBe(
			false
		);
	} );

	it( 'is off when --no-pager (flags.pager === false)', () => {
		expect( shouldUsePager( flags( { pager: false } ), true, false ) ).toBe(
			false
		);
	} );
} );

describe( 'resolvePagerCommand', () => {
	it( 'prefers WRAPIDO_PAGER over PAGER', () => {
		expect(
			resolvePagerCommand( { WRAPIDO_PAGER: 'bat', PAGER: 'less' } )
		).toBe( 'bat' );
	} );

	it( 'falls back to PAGER', () => {
		expect( resolvePagerCommand( { PAGER: 'most' } ) ).toBe( 'most' );
	} );

	it( 'defaults to "less -FRX" on non-Windows with nothing set', () => {
		if ( process.platform === 'win32' ) {
			expect( resolvePagerCommand( {} ) ).toBeUndefined();
		} else {
			expect( resolvePagerCommand( {} ) ).toBe( 'less -FRX' );
		}
	} );

	it( 'an empty WRAPIDO_PAGER disables paging', () => {
		expect( resolvePagerCommand( { WRAPIDO_PAGER: '' } ) ).toBeUndefined();
	} );

	it( 'an empty PAGER disables paging (WRAPIDO_PAGER unset)', () => {
		expect( resolvePagerCommand( { PAGER: '' } ) ).toBeUndefined();
	} );
} );
