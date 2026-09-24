/**
 * External dependencies
 */
import { defineConfig } from 'tsup';

export default defineConfig( {
	entry: [ 'src/cli.ts' ],
	format: [ 'esm' ],
	target: 'node20',
	clean: true,
	dts: false,
	// Only emit a sourcemap when collecting coverage (`npm run coverage`) —
	// c8 needs it to map dist/cli.js's V8 coverage back to the original
	// src/*.ts lines, since the integration suite spawns the built CLI as a
	// child process rather than running it in-process. A normal `npm run
	// build` skips it, keeping the published package (`files: ["dist"]`)
	// free of an unused .map file.
	sourcemap: process.env.WRAPIDO_COVERAGE === 'true',
	banner: {
		js: '#!/usr/bin/env node',
	},
} );
