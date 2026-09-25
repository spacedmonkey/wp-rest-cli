/**
 * Internal dependencies
 */
import type { WpApiErrorBody } from '../types.js';

/** An error returned by the WordPress REST API itself (parsed {code,message,data} body). */
export class WpApiError extends Error {
	readonly code: string;
	readonly status: number;
	readonly params?: Record< string, string >;
	readonly headers?: Headers;
	/** A CLI-added hint that overrides the code-keyed lookup in `hintFor`, when set by the caller after construction. */
	hint?: string;

	/**
	 * @param body           The parsed `{code, message, data}` error body.
	 * @param fallbackStatus HTTP status to use when the body carries none.
	 * @param headers        The failed response's headers, if available.
	 */
	constructor(
		body: WpApiErrorBody,
		fallbackStatus: number,
		headers?: Headers
	) {
		super( body.message );
		this.name = 'WpApiError';
		this.code = body.code;
		this.status = body.data?.status ?? fallbackStatus;
		this.params = body.data?.params;
		this.headers = headers;
	}
}

/** Raised when the CLI itself can't proceed (bad args, discovery failure, etc.), not a REST API error. */
export class CliError extends Error {
	readonly headers?: Headers;

	/**
	 * @param message The human-readable error message.
	 * @param headers The failed response's headers, if the error came from one.
	 */
	constructor( message: string, headers?: Headers ) {
		super( message );
		this.name = 'CliError';
		this.headers = headers;
	}
}

/** Hints appended to `rest_upload_*` errors, keyed by WordPress error code. */
const UPLOAD_ERROR_HINTS: Record< string, string > = {
	rest_upload_no_data:
		'No file data reached WordPress. The file may be empty, or larger than the server allows (PHP post_max_size).',
	rest_upload_unknown_error:
		'The file may be a type WordPress does not allow, or larger than PHP upload_max_filesize.',
	rest_upload_sideload_error:
		'The file may be a type WordPress does not allow, or larger than PHP upload_max_filesize.',
	rest_upload_file_too_big:
		'The file is larger than this site allows; raise the upload size limit or use a smaller file.',
	rest_upload_limited_space: 'This site has run out of upload space.',
	rest_upload_user_quota_exceeded: 'This user has exceeded the upload quota.',
	rest_upload_image_type_not_supported:
		'The server cannot process this image type.',
};

/** Hints for common auth/routing/validation errors, keyed by WordPress error code. */
const GENERAL_ERROR_HINTS: Record< string, string > = {
	rest_forbidden:
		'Not allowed: check credentials (see `wrapido auth ... status`) and that the user has the needed capability.',
	rest_no_route:
		'No such route: run `wrapido <namespace>` to list routes and `wrapido help <namespace> <route>` for its verbs.',
	rest_forbidden_context:
		'This --context (e.g. edit) needs a real authenticated user; a client_credentials token acts as user 0. Try --context=view.',
	rest_post_invalid_id: 'No item has that id; run `list` to find valid ids.',
	rest_invalid_param:
		'A field value is invalid: run `wrapido help <namespace> <route> <verb>` for the accepted fields and types.',
};

/**
 * Looks up a hint for a WordPress error code. Exported so callers building a
 * more specific hint (e.g. `generate`'s schema-less recovery path in
 * `rest.ts`) can check whether a code-keyed hint already exists before
 * overriding `WpApiError.hint` with something less relevant.
 * @param code The WordPress REST error code.
 * @return The hint text, if one is known.
 */
export function hintFor( code: string ): string | undefined {
	return (
		UPLOAD_ERROR_HINTS[ code ] ??
		GENERAL_ERROR_HINTS[ code ] ??
		( code.startsWith( 'rest_cannot_' )
			? 'The authenticated user lacks the capability for this action (or no credentials were sent).'
			: undefined )
	);
}

/**
 * Strips markup from an HTML error page (e.g. an nginx/Apache error) so the
 * text of a non-JSON error body is readable.
 * @param html The raw response text.
 * @return The text content, whitespace-collapsed.
 */
function stripHtml( html: string ): string {
	return html
		.replace( /<(script|style)[\s\S]*?<\/\1>/gi, ' ' )
		.replace( /<[^>]*>/g, ' ' )
		.replace( /\s+/g, ' ' )
		.trim();
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
			return new WpApiError( body, response.status, response.headers );
		}
	} catch {
		// fall through to raw text error below
	}
	if ( response.status === 413 ) {
		return new CliError(
			'The server rejected the request body as too large (HTTP 413). Check the web server (client_max_body_size) and PHP (upload_max_filesize, post_max_size) upload limits.',
			response.headers
		);
	}
	const detail = /<\/?[a-z][\s\S]*>/i.test( text ) ? stripHtml( text ) : text;
	return new CliError(
		`Request failed with status ${ response.status }${
			detail ? `: ${ detail.slice( 0, 500 ) }` : ''
		}`,
		response.headers
	);
}

/**
 * Renders any caught error as a single "Error: ..." line for the top-level CLI catch.
 * @param error The caught value, of any shape.
 * @return A human-readable, one-line error message.
 */
export function formatErrorForDisplay( error: unknown ): string {
	if ( error instanceof WpApiError ) {
		const hint = error.hint ?? hintFor( error.code );
		const params = Object.entries( error.params ?? {} )
			.map( ( [ name, message ] ) => `\n  ${ name }: ${ message }` )
			.join( '' );
		return `Error: ${ error.message } (${ error.code }, status ${
			error.status
		})${ params }${ hint ? `\n${ hint }` : '' }`;
	}
	if ( error instanceof CliError ) {
		return `Error: ${ error.message }`;
	}
	if ( error instanceof Error ) {
		return `Error: ${ error.message }`;
	}
	return `Error: ${ String( error ) }`;
}

/**
 * Renders a caught error as a single JSON object, for `--format=json`.
 * @param error The caught value, of any shape.
 * @return JSON text: `{error: {message, code?, status?, params?, hint?}}`.
 */
export function formatErrorForJson( error: unknown ): string {
	const message = error instanceof Error ? error.message : String( error );
	if ( error instanceof WpApiError ) {
		return JSON.stringify( {
			error: {
				message,
				code: error.code,
				status: error.status,
				params: error.params,
				hint: error.hint ?? hintFor( error.code ),
			},
		} );
	}
	return JSON.stringify( { error: { message } } );
}
