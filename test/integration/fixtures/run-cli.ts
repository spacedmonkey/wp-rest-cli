/**
 * External dependencies
 */
import { execa } from 'execa';
import { fileURLToPath } from 'node:url';

/**
 * The built CLI entry point. Integration tests spawn this (via `node`)
 * rather than `tsx`-transpiling `src/cli.ts` on every call — `tsx`'s
 * cold-start/transform cost, paid independently by every one of the
 * hundreds of spawns across the integration suite, is by far the biggest
 * contributor to the suite's wall-clock time. `pretest:integration`
 * (package.json) builds this file before `test:integration` runs; running
 * `vitest run` directly (bypassing that npm hook) requires a prior
 * `npm run build`.
 */
const distCliEntry = fileURLToPath(
	new URL( '../../../dist/cli.js', import.meta.url )
);

/**
 * Extra options `runCli` accepts on top of its own defaults. Deliberately
 * narrower than execa's full `Options` type (just the one field callers in
 * this suite actually vary) — spreading the full `Options` type here would
 * widen `stdout`/`stderr` on the returned result to `string | string[] |
 * ...` for every caller, since TypeScript can no longer statically tell
 * that `lines`/`encoding`/etc. are left unset.
 */
type RunCliOptions = {
	env?: Record< string, string | undefined >;
	cwd?: string;
};

/** Every env var that can switch agent mode on, unset for the child. */
const AGENT_ENV_SCRUB: Record< string, undefined > = Object.fromEntries(
	[
		'WP_REST_CLI_AGENT',
		'AI_AGENT',
		'CLAUDECODE',
		'CODEX_CI',
		'CODEX_SANDBOX',
		'CODEX_THREAD_ID',
		'COPILOT_AGENT',
		'COPILOT_ALLOW_ALL',
	].map( ( name ) => [ name, undefined ] )
);

/**
 * Spawns the built CLI as a child process.
 * @param args    CLI arguments.
 * @param options Extra options (`env`, `cwd`), merged over the
 *                shared defaults. `reject: false` is always used so a
 *                non-zero exit code is asserted on directly rather than
 *                thrown.
 * @return The execa result promise.
 */
export function runCli( args: string[], options: RunCliOptions = {} ) {
	return execa( 'node', [ distCliEntry, ...args ], {
		reject: false,
		...options,
		// The suite itself may run inside an AI agent's shell, so scrub every
		// agent marker: tests opt in explicitly (e.g. `WP_REST_CLI_AGENT: '1'`).
		env: { ...AGENT_ENV_SCRUB, ...options.env },
	} );
}
