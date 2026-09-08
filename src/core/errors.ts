import type { WpApiErrorBody } from '../types.js';

/** An error returned by the WordPress REST API itself (parsed {code,message,data} body). */
export class WpApiError extends Error {
	readonly code: string;
	readonly status: number;
	readonly params?: Record< string, string >;

	constructor( body: WpApiErrorBody, fallbackStatus: number ) {
		super( body.message );
		this.name = 'WpApiError';
		this.code = body.code;
		this.status = body.data?.status ?? fallbackStatus;
		this.params = body.data?.params;
	}
}

/** Raised when the CLI itself can't proceed (bad args, discovery failure, etc.), not a REST API error. */
export class CliError extends Error {
	constructor( message: string ) {
		super( message );
		this.name = 'CliError';
	}
}

/**
 * Turns a non-2xx `fetch` Response into a typed error: a {@link WpApiError} if
 * the body is a well-formed WP REST API error, otherwise a {@link CliError}
 * carrying the raw response text.
 * @param response The failed HTTP response.
 * @return The parsed error.
 */
export async function parseErrorResponse(
	response: Response
): Promise< WpApiError | CliError > {
	const text = await response.text();
	try {
		const body = JSON.parse( text ) as WpApiErrorBody;
		if (
			body &&
			typeof body.code === 'string' &&
			typeof body.message === 'string'
		) {
			return new WpApiError( body, response.status );
		}
	} catch {
		// fall through to raw text error below
	}
	return new CliError(
		`Request failed with status ${ response.status }${
			text ? `: ${ text.slice( 0, 500 ) }` : ''
		}`
	);
}

/**
 * Renders any caught error as a single "Error: ..." line for the top-level CLI catch.
 * @param error The caught value, of any shape.
 * @return A human-readable, one-line error message.
 */
export function formatErrorForDisplay( error: unknown ): string {
	if ( error instanceof WpApiError ) {
		return `Error: ${ error.message } (${ error.code }, status ${ error.status })`;
	}
	if ( error instanceof CliError ) {
		return `Error: ${ error.message }`;
	}
	if ( error instanceof Error ) {
		return `Error: ${ error.message }`;
	}
	return `Error: ${ String( error ) }`;
}
