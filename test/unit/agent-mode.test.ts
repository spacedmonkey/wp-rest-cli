/**
 * External dependencies
 */
import { afterEach, describe, expect, it } from '@jest/globals';

/**
 * Internal dependencies
 */
import { agentMode, agentModeReason } from '../../src/ui.js';

const MARKERS = [
	'WP_REST_CLI_AGENT',
	'AI_AGENT',
	'CLAUDECODE',
	'CODEX_CI',
	'CODEX_SANDBOX',
	'CODEX_THREAD_ID',
	'COPILOT_AGENT',
	'COPILOT_ALLOW_ALL',
	'CLINE_ACTIVE',
	'CURSOR_AGENT',
];

describe( 'agentMode auto-detection', () => {
	afterEach( () => {
		for ( const name of MARKERS ) {
			delete process.env[ name ];
		}
	} );

	it( 'is off with no markers', () => {
		expect( agentMode() ).toBe( false );
		expect( agentModeReason() ).toBeUndefined();
	} );

	it.each( [
		'AI_AGENT',
		'CLAUDECODE',
		'CODEX_CI',
		'CODEX_SANDBOX',
		'CODEX_THREAD_ID',
		'COPILOT_AGENT',
		'COPILOT_ALLOW_ALL',
		'CLINE_ACTIVE',
		'CURSOR_AGENT',
	] )( 'turns on from %s alone', ( name ) => {
		process.env[ name ] = '1';
		expect( agentMode() ).toBe( true );
		expect( agentModeReason() ).toBe( name );
	} );

	it( 'WP_REST_CLI_AGENT=0 overrides every marker', () => {
		process.env.AI_AGENT = '1';
		process.env.CLAUDECODE = '1';
		process.env.WP_REST_CLI_AGENT = '0';
		expect( agentMode() ).toBe( false );
	} );

	it( 'a falsy AI_AGENT value is off, and does not fall through to other markers', () => {
		process.env.AI_AGENT = 'false';
		expect( agentModeReason() ).toBeUndefined();
	} );

	it( 'WP_REST_CLI_AGENT=1 wins with no other markers set', () => {
		process.env.WP_REST_CLI_AGENT = '1';
		expect( agentModeReason() ).toBe( 'WP_REST_CLI_AGENT' );
	} );

	it( 'a falsy AI_AGENT overrides a marker too, like WP_REST_CLI_AGENT=0 does', () => {
		process.env.CLAUDECODE = '1';
		process.env.AI_AGENT = 'off';
		expect( agentModeReason() ).toBeUndefined();
	} );
} );
