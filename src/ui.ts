/**
 * External dependencies
 */
import cliProgress from 'cli-progress';
import ora, { type Ora } from 'ora';
import picocolors from 'picocolors';

// Every colorized call site in this codebase imports `pc` from here (rather
// than straight from `picocolors`) so that `setColorEnabled` - called once,
// at startup, from the resolved `--no-color` flag - can override picocolors'
// own TTY-based auto-detection everywhere at once via this live binding.
let pc = picocolors.createColors( true );

/**
 * Enables or disables color for every `pc.*` call in the app, overriding
 * picocolors' own TTY-based auto-detection so `--no-color` is the only thing
 * that turns color off (it's on by default even when output is piped).
 * @param enabled Whether colorized output should be emitted.
 */
export function setColorEnabled( enabled: boolean ): void {
	pc = picocolors.createColors( enabled );
}

/**
 * Starts a terminal spinner, unless spinners are disabled (e.g. non-TTY output).
 * @param text    Label shown next to the spinner.
 * @param enabled Whether spinners are enabled for this invocation.
 * @return The running spinner, or undefined when disabled.
 */
export function spinner( text: string, enabled: boolean ): Ora | undefined {
	if ( ! enabled ) {
		return undefined;
	}
	return ora( { text, isEnabled: true } ).start();
}

/**
 * Runs an async task behind a spinner, marking it succeeded or failed based on
 * whether the task throws.
 * @param text    Label shown next to the spinner.
 * @param enabled Whether spinners are enabled for this invocation.
 * @param task    The async work to run.
 * @return The task's resolved value.
 */
export async function withSpinner< T >(
	text: string,
	enabled: boolean,
	task: () => Promise< T >
): Promise< T > {
	const spin = spinner( text, enabled );
	try {
		const result = await task();
		spin?.succeed( text );
		return result;
	} catch ( error ) {
		spin?.fail( text );
		throw error;
	}
}

/**
 * Prints a one-off informational line, unless progress output is disabled.
 * Uses `ora`'s persisted-line output (like `withSpinner`'s final state line)
 * rather than `console.*`, so it prints immediately — e.g. before a
 * following sequence of `withSpinner` calls — instead of being batched into
 * a command's final returned output string.
 * @param message The note to print.
 * @param enabled Whether progress output is enabled for this invocation —
 *                pass the same value `spinner`'s `enabled` param gets
 *                (typically `! flags.quiet`).
 */
export function notice( message: string, enabled: boolean ): void {
	if ( ! enabled ) {
		return;
	}
	ora().info( message );
}

/** A running progress bar, as returned by {@link createProgressBar}. */
export interface ProgressBar {
	/** Advances the bar by one step. */
	tick: () => void;
	/**
	 * Prints a line above the bar without disturbing it (the bar redraws
	 * itself on the line below immediately after).
	 * @param message The line to print.
	 */
	log: ( message: string ) => void;
	/** Stops the bar, leaving the terminal on a fresh line below it. */
	finish: () => void;
}

/**
 * Real WP-CLI's own progress bar (`\cli\progress\Bar`) look: a message,
 * the percentage, a `[===>   ]`-style ASCII bar, and elapsed/estimated
 * time — reproduced here with `cli-progress`'s own preset mechanism.
 */
const WP_CLI_PROGRESS_PRESET: cliProgress.Preset = {
	barCompleteChar: '=',
	barIncompleteChar: ' ',
	format: '{msg}  {percentage}% [{bar}] {duration_formatted} / {eta_formatted}',
};

/** A no-op progress bar, returned by {@link createProgressBar} when disabled. */
const NULL_PROGRESS_BAR: ProgressBar = {
	tick() {},
	log() {},
	finish() {},
};

/**
 * Starts a WP-CLI-styled progress bar, unless progress output is disabled
 * or there's nothing to track. Writes to stderr, like `spinner`/`notice`,
 * so stdout stays clean for scripts parsing e.g. `--format=json` output.
 * @param message Label shown before the bar (e.g. `Generating wp/v2/posts`).
 * @param total   The number of `tick()` calls that make up 100%.
 * @param enabled Whether the bar is enabled for this invocation — pass the
 *                same value `spinner`'s `enabled` param gets (typically
 *                `! flags.quiet`).
 * @return The running progress bar.
 */
export function createProgressBar(
	message: string,
	total: number,
	enabled: boolean
): ProgressBar {
	if ( ! enabled || total <= 0 ) {
		return NULL_PROGRESS_BAR;
	}
	const bar = new cliProgress.SingleBar(
		{
			hideCursor: true,
			clearOnComplete: false,
			stream: process.stderr,
		},
		WP_CLI_PROGRESS_PRESET
	);
	bar.start( total, 0, { msg: message } );
	return {
		tick() {
			bar.increment();
		},
		// Routed through `notice` (ora), not cli-progress's own `MultiBar.log()`
		// buffering — that buffer only ever flushes on the bar's own redraw
		// timer, which (like the bar itself) never fires outside a real TTY,
		// so a message logged just before the bar finishes could be silently
		// lost. `notice` prints immediately and unconditionally instead.
		log( logMessage: string ) {
			notice( logMessage, true );
		},
		finish() {
			bar.stop();
		},
	};
}

/**
 * Formats a green "Success: ..." line for CLI output.
 * @param message The success message.
 */
export function success( message: string ): string {
	return pc.green( `Success: ${ message }` );
}

/**
 * Formats a yellow "Warning: ..." line for CLI output.
 * @param message The warning message.
 */
export function warn( message: string ): string {
	return pc.yellow( `Warning: ${ message }` );
}

/**
 * Formats a red error line for CLI output.
 * @param message The error message.
 */
export function errorText( message: string ): string {
	return pc.red( message );
}

export { pc };
