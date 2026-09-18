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

/**
 * Field names masked by {@link redactBody} wherever they appear in a request
 * body — e.g. an OAuth2 token exchange's `client_secret`/`code`, or a
 * `password` field on a user create/update request. Headers already get this
 * treatment via {@link redactHeaders}; a credential riding in the body
 * (rather than an `Authorization` header) needs the same protection, or
 * `--debug` would print it verbatim.
 *
 * These are matched by bare key name across every request, not scoped to the
 * OAuth2 token endpoint specifically — a deliberate over-redaction. `code` in
 * particular could collide with an unrelated WP field of the same name (a
 * coupon/postal/taxonomy code, say), hiding it from `--debug` output too.
 * Accepted: erring toward redacting a field that didn't need it is a far
 * smaller cost than ever printing a real secret.
 */
const SENSITIVE_BODY_KEYS = new Set( [
	'password',
	'client_secret',
	'code',
	'access_token',
	'refresh_token',
] );

/**
 * Recursively masks {@link SENSITIVE_BODY_KEYS} values in a parsed JSON body, in place.
 * @param value The parsed JSON value (object, array, or primitive) to redact.
 */
function redactJsonInPlace( value: unknown ): void {
	if ( Array.isArray( value ) ) {
		for ( const item of value ) {
			redactJsonInPlace( item );
		}
		return;
	}
	if ( value && typeof value === 'object' ) {
		const record = value as Record< string, unknown >;
		for ( const key of Object.keys( record ) ) {
			if ( SENSITIVE_BODY_KEYS.has( key ) ) {
				record[ key ] = '<redacted>';
			} else {
				redactJsonInPlace( record[ key ] );
			}
		}
	}
}

/**
 * Masks known credential-bearing fields in a request body before it's
 * logged — both form-encoded bodies (e.g. an OAuth2 token exchange's
 * `client_secret`/`code`) and JSON bodies (e.g. a `password` field). Falls
 * back to returning `body` unchanged if it's neither shape, rather than
 * throwing on a body this function doesn't recognize.
 * @param body        The raw request body about to be logged.
 * @param contentType The request's `Content-Type` header, if set.
 * @return `body` with sensitive field values masked.
 */
export function redactBody( body: string, contentType?: string ): string {
	if ( contentType?.includes( 'application/x-www-form-urlencoded' ) ) {
		const params = new URLSearchParams( body );
		for ( const key of params.keys() ) {
			if ( SENSITIVE_BODY_KEYS.has( key ) ) {
				params.set( key, '<redacted>' );
			}
		}
		return params.toString();
	}
	try {
		const parsed: unknown = JSON.parse( body );
		redactJsonInPlace( parsed );
		return JSON.stringify( parsed );
	} catch {
		// Not JSON (or a bare string body) — nothing this function knows how
		// to redact, so log it as-is.
		return body;
	}
}
