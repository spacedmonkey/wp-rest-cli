/**
 * External dependencies
 */
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
