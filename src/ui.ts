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
