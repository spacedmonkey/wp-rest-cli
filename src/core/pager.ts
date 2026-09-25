/**
 * External dependencies
 */
import { spawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import process from 'node:process';

/** The one `spawn` call shape {@link runPager} needs — narrowed from its real overloaded signature so a test can inject a fake without touching real processes. */
type Spawn = ( command: string, options: SpawnOptions ) => ChildProcess;

/**
 * Internal dependencies
 */
import type { GlobalFlags } from '../types.js';
import { agentMode } from '../ui.js';

/**
 * Whether output should be paged for this invocation: only when stdout
 * is a real interactive terminal, agent mode is off, `--quiet` wasn't
 * passed, and neither `--no-pager` nor a `pager: false` config-file value
 * turned it off. This can only ever narrow the default (`isTTY` on, nothing
 * else off) — nothing can force paging on when stdout isn't a live
 * terminal, by design: there is no `--pager` flag, only `--no-pager`.
 * @param flags   The resolved global flags (`flags.pager` defaults true).
 * @param isTTY   Whether stdout is a live terminal — pass `process.stdout.isTTY`.
 * @param agentOn Whether agent mode is on — pass `agentMode()`.
 * @return True when output should be piped through a pager.
 */
export function shouldUsePager(
	flags: GlobalFlags,
	isTTY: boolean,
	agentOn: boolean
): boolean {
	return isTTY && ! agentOn && ! flags.quiet && flags.pager !== false;
}

/**
 * Resolves the shell command to run as the pager: `WRAPIDO_PAGER`, then
 * `PAGER`, then `less -FRX` (git's own default flags: quit if the content
 * fits one screen, pass through ANSI color, don't clear the screen on exit)
 * — except on Windows, where `less` isn't reliably present, so there is no
 * built-in default there; an explicit `WRAPIDO_PAGER`/`PAGER` still works.
 * An explicitly *empty* `WRAPIDO_PAGER`/`PAGER` (`PAGER=`) disables paging,
 * the same convention those variables already carry elsewhere (e.g. git).
 * @param env The environment to read from.
 * @return The command to run, or undefined when there is none.
 */
export function resolvePagerCommand(
	env: NodeJS.ProcessEnv = process.env
): string | undefined {
	if ( env.WRAPIDO_PAGER !== undefined ) {
		return env.WRAPIDO_PAGER === '' ? undefined : env.WRAPIDO_PAGER;
	}
	if ( env.PAGER !== undefined ) {
		return env.PAGER === '' ? undefined : env.PAGER;
	}
	return process.platform === 'win32' ? undefined : 'less -FRX';
}

/**
 * Pipes `output` into `command` via the shell, mirroring `console.log`'s own
 * trailing newline so paged and unpaged output are byte-identical. Resolves
 * `false` only when the pager could not be started at all, so the caller can
 * fall back to `console.log`; once anything has been written to the pager's
 * stdin, this always resolves `true`, even if the pager itself later exits
 * non-zero (e.g. a broken custom `$PAGER`) — the same way `git log | badcmd`
 * fails visibly once rather than silently retrying without a pager and
 * double-printing the output.
 * @param command The shell command to run (may contain flags/pipes/quoting).
 * @param output  The text to page.
 * @param spawnFn `node:child_process`'s `spawn`, overridable in tests.
 * @return Whether the pager was started.
 */
export function runPager(
	command: string,
	output: string,
	spawnFn: Spawn = spawn
): Promise< boolean > {
	return new Promise( ( resolve ) => {
		let settled = false;
		let child;
		try {
			child = spawnFn( command, {
				shell: true,
				stdio: [ 'pipe', 'inherit', 'inherit' ],
			} );
		} catch {
			resolve( false );
			return;
		}
		child.on( 'error', () => {
			if ( ! settled ) {
				settled = true;
				resolve( false );
			}
		} );
		child.on( 'spawn', () => {
			// Only write once the process has actually started, so an
			// unlaunchable shell never partially writes before falling back.
			child.stdin?.on( 'error', () => {} ); // EPIPE: user quit early ('q').
			child.stdin?.write(
				output.endsWith( '\n' ) ? output : `${ output }\n`
			);
			child.stdin?.end();
		} );
		child.on( 'close', () => {
			if ( ! settled ) {
				settled = true;
				resolve( true );
			}
		} );
	} );
}

/** Matches an SGR ANSI color escape (e.g. picocolors' `\x1b[1m`), so it doesn't inflate a line's measured width. */
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

/**
 * Whether `output` already fits within the terminal's current size, in which
 * case paging it would add nothing over printing it directly — computed here
 * rather than left entirely to the pager's own "quit if it fits one screen"
 * flag (`less -F`), which is a well-known unreliable heuristic across real
 * terminals/multiplexers: it can open anyway and render short content
 * anchored to the bottom of the screen instead of skipping straight to a
 * normal top-anchored print. ANSI color codes are stripped before measuring
 * each line's width so they don't count toward it.
 * @param output  The text that would be paged.
 * @param rows    The terminal's current height, or undefined if unknown.
 * @param columns The terminal's current width, or undefined if unknown.
 * @return True when the content needs no more than one screen.
 */
export function fitsOnScreen(
	output: string,
	rows: number | undefined,
	columns: number | undefined
): boolean {
	if ( ! rows ) {
		return false;
	}
	const screenLines = output.split( '\n' ).reduce( ( total, line ) => {
		const visibleLength = line.replace( ANSI_PATTERN, '' ).length;
		const wrapped = columns
			? Math.max( 1, Math.ceil( visibleLength / columns ) )
			: 1;
		return total + wrapped;
	}, 0 );
	return screenLines < rows;
}

/**
 * The single choke point for printing a command's final output string
 * — replaces a bare `console.log(output)`. Pages it through the resolved
 * pager when {@link shouldUsePager} says to, the content doesn't already fit
 * on one screen ({@link fitsOnScreen}), and a pager command resolves and
 * starts; otherwise (or on any failure to start one) prints exactly as
 * `console.log(output)` always did, so this is a behavior no-op whenever the
 * gate is false.
 * @param output The complete output string to print.
 * @param flags  The resolved global flags.
 */
export async function printOutput(
	output: string,
	flags: GlobalFlags
): Promise< void > {
	const isTTY = Boolean( process.stdout.isTTY );
	if (
		! shouldUsePager( flags, isTTY, agentMode() ) ||
		fitsOnScreen( output, process.stdout.rows, process.stdout.columns )
	) {
		console.log( output );
		return;
	}
	const command = resolvePagerCommand();
	if ( ! command || ! ( await runPager( command, output ) ) ) {
		console.log( output );
	}
}
