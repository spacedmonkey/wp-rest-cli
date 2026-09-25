/**
 * External dependencies
 */
import { describe, expect, it } from '@jest/globals';

/**
 * Internal dependencies
 */
import { createProgressBar } from '../../src/ui.js';

describe( 'createProgressBar', () => {
	it( 'restores the terminal on Ctrl-C only while the bar is running', () => {
		const before = process.listenerCount( 'SIGINT' );
		const bar = createProgressBar( 'Working', 2, true );
		expect( process.listenerCount( 'SIGINT' ) ).toBe( before + 1 );
		bar.finish();
		expect( process.listenerCount( 'SIGINT' ) ).toBe( before );
	} );
} );
