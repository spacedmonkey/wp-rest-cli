/**
 * Turns off TLS certificate verification for every HTTPS request this process
 * makes (`fetch` and `node:https` alike), so sites with self-signed, expired or
 * mismatched certificates — typical of local and staging WordPress installs — just
 * work. Node reads `NODE_TLS_REJECT_UNAUTHORIZED` when a connection is opened, so
 * setting it once at startup covers every request without a per-call option.
 *
 * Node prints a security warning about this on every run; it is dropped here
 * because the behaviour is deliberate and documented, not an accident.
 */
export function disableTlsVerification(): void {
	const emitWarning = process.emitWarning.bind( process );
	process.emitWarning = ( ( warning: string | Error, ...rest: unknown[] ) => {
		const text = typeof warning === 'string' ? warning : warning.message;
		if ( text.includes( 'NODE_TLS_REJECT_UNAUTHORIZED' ) ) {
			return;
		}
		( emitWarning as ( ...args: unknown[] ) => void )( warning, ...rest );
	} ) as typeof process.emitWarning;
	process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}
