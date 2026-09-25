/**
 * External dependencies
 */
import { describe, expect, it } from '@jest/globals';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

/**
 * Internal dependencies
 */
import {
	fitsOnScreen,
	resolvePagerCommand,
	runPager,
	shouldUsePager,
} from '../../src/core/pager.js';
import type { GlobalFlags } from '../../src/types.js';

/** A minimal stand-in for `ChildProcess.stdin`: records writes synchronously, no real stream semantics needed for these tests. */
function fakeStdin() {
	const chunks: string[] = [];
	let onError: ( () => void ) | undefined;
	return {
		chunks,
		on: ( event: string, cb: () => void ) => {
			if ( event === 'error' ) {
				onError = cb;
			}
		},
		write: ( data: string ) => {
			chunks.push( data );
			return true;
		},
		end: () => {},
		emitStdinError: () => onError?.(),
	};
}

/** A minimal stand-in for a spawned `ChildProcess`, driven by hand via `.emit(...)`. */
function fakeChild() {
	return Object.assign( new EventEmitter(), { stdin: fakeStdin() } );
}

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

describe( 'fitsOnScreen', () => {
	it( 'fits when the line count is below the terminal height', () => {
		expect( fitsOnScreen( 'a\nb\nc', 24, 80 ) ).toBe( true );
	} );

	it( 'does not fit when the line count reaches the terminal height', () => {
		const output = Array.from( { length: 24 }, () => 'a line' ).join(
			'\n'
		);
		expect( fitsOnScreen( output, 24, 80 ) ).toBe( false );
	} );

	it( 'does not fit when a single unwrapped-looking line actually wraps past the terminal height', () => {
		// 200 visible chars at 80 columns wraps to 3 screen rows - more than
		// this terminal's height, even though it is only one logical line.
		const wideLine = 'x'.repeat( 200 );
		expect( fitsOnScreen( wideLine, 2, 80 ) ).toBe( false );
	} );

	it( 'ignores ANSI color codes when measuring a line’s width', () => {
		const colored = `\x1b[1mheading\x1b[22m`;
		expect( fitsOnScreen( colored, 24, 80 ) ).toBe( true );
	} );

	it( 'assumes it does not fit when the terminal height is unknown (not a real TTY)', () => {
		expect( fitsOnScreen( 'a', undefined, 80 ) ).toBe( false );
	} );

	it( 'falls back to one row per line when the terminal width is unknown', () => {
		expect( fitsOnScreen( 'a\nb\nc', 24, undefined ) ).toBe( true );
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

	it( 'defaults to "less -FR" (no -X, so mouse/trackpad scrolling works) on non-Windows with nothing set', () => {
		if ( process.platform === 'win32' ) {
			expect( resolvePagerCommand( {} ) ).toBeUndefined();
		} else {
			expect( resolvePagerCommand( {} ) ).toBe( 'less -FR' );
		}
	} );

	it( 'an empty WRAPIDO_PAGER disables paging', () => {
		expect( resolvePagerCommand( { WRAPIDO_PAGER: '' } ) ).toBeUndefined();
	} );

	it( 'an empty PAGER disables paging (WRAPIDO_PAGER unset)', () => {
		expect( resolvePagerCommand( { PAGER: '' } ) ).toBeUndefined();
	} );

	it( 'treats a whitespace-only WRAPIDO_PAGER as a literal command, not "disabled"', () => {
		// Only an exactly-empty value disables paging, matching git's own
		// $PAGER convention — a value like " " is passed through as-is.
		expect( resolvePagerCommand( { WRAPIDO_PAGER: ' ' } ) ).toBe( ' ' );
	} );
} );

describe( 'runPager', () => {
	it( 'writes the output (plus a trailing newline) to the pager and resolves true on close', async () => {
		const child = fakeChild();
		const promise = runPager(
			'less',
			'hello',
			() => child as unknown as ChildProcess
		);
		child.emit( 'spawn' );
		child.emit( 'close' );
		await expect( promise ).resolves.toBe( true );
		expect( child.stdin.chunks.join( '' ) ).toBe( 'hello\n' );
	} );

	it( 'does not add a second trailing newline when one is already present', async () => {
		const child = fakeChild();
		const promise = runPager(
			'less',
			'hello\n',
			() => child as unknown as ChildProcess
		);
		child.emit( 'spawn' );
		child.emit( 'close' );
		await promise;
		expect( child.stdin.chunks.join( '' ) ).toBe( 'hello\n' );
	} );

	it( 'resolves false, without writing anything, when the process fails to start', async () => {
		const child = fakeChild();
		const promise = runPager(
			'less',
			'hello',
			() => child as unknown as ChildProcess
		);
		child.emit( 'error', new Error( 'ENOENT' ) );
		await expect( promise ).resolves.toBe( false );
		expect( child.stdin.chunks ).toEqual( [] );
	} );

	it( 'resolves false when starting the pager throws synchronously', async () => {
		const spawnFn: Parameters< typeof runPager >[ 2 ] = () => {
			throw new Error( 'boom' );
		};
		await expect( runPager( 'less', 'hello', spawnFn ) ).resolves.toBe(
			false
		);
	} );

	it( 'still resolves true if the pager later exits non-zero (a broken custom $PAGER)', async () => {
		const child = fakeChild();
		const promise = runPager(
			'badcmd',
			'hello',
			() => child as unknown as ChildProcess
		);
		child.emit( 'spawn' );
		child.emit( 'close', 127 );
		await expect( promise ).resolves.toBe( true );
	} );

	it( 'swallows an EPIPE-style stdin error (user quit the pager early) without rejecting', async () => {
		const child = fakeChild();
		const promise = runPager(
			'less',
			'hello',
			() => child as unknown as ChildProcess
		);
		child.emit( 'spawn' );
		child.stdin.emitStdinError();
		child.emit( 'close' );
		await expect( promise ).resolves.toBe( true );
	} );
} );
