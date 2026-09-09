/**
 * Internal dependencies
 */
import { pc } from '../ui.js';

/**
 * Prints a `--debug` diagnostic line to stderr, so it never pollutes stdout output that scripts may parse.
 * @param line The diagnostic line to print.
 */
export function debugLog( line: string ): void {
	console.error( pc.dim( line ) );
}

/**
 * Masks credential-bearing header values (e.g. `Authorization: Basic xxxx`) before they're logged.
 * @param headers Headers to redact.
 * @return A copy of `headers` with sensitive values masked.
 */
export function redactHeaders(
	headers: Record< string, string >
): Record< string, string > {
	const redacted: Record< string, string > = {};
	for ( const [ key, value ] of Object.entries( headers ) ) {
		if ( key.toLowerCase() === 'authorization' ) {
			const [ scheme ] = value.split( ' ' );
			redacted[ key ] = `${ scheme } <redacted>`;
		} else {
			redacted[ key ] = value;
		}
	}
	return redacted;
}
