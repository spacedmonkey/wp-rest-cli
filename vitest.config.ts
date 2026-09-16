/**
 * External dependencies
 */
import { defineConfig } from 'vitest/config';

export default defineConfig( {
	test: {
		environment: 'node',
		include: [ 'test/integration/**/*.test.ts' ],
		// Every test here spawns a real `tsx` child process (sometimes several
		// in sequence), so cold-start/transform overhead — and just ordinary
		// variance under system load — can push a test past vitest's 5s
		// default even though nothing is actually wrong. Past sessions worked
		// around this ad hoc with a `--testTimeout=20000` CLI flag rather than
		// fixing it here, which meant it only helped when someone remembered
		// to pass it.
		testTimeout: 20000,
	},
} );
