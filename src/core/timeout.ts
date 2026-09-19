/** The user's `--timeout` in milliseconds, when one was given. */
let userTimeoutMs: number | undefined;

/**
 * Records the user's `--timeout` so every HTTP request made afterwards honours it.
 * @param ms The timeout in milliseconds, or undefined to keep each request's default.
 */
export function setUserTimeout( ms: number | undefined ): void {
	userTimeoutMs = ms;
}

/**
 * Picks the timeout for one request: the user's `--timeout` if given, else the
 * request's own default.
 * @param defaultMs The timeout to use when the user didn't pass `--timeout`.
 * @return The timeout in milliseconds.
 */
export function resolveTimeout( defaultMs: number ): number {
	return userTimeoutMs ?? defaultMs;
}

/**
 * The one place this CLI calls `fetch`, so `--timeout` applies to every HTTP
 * request. Adds an `AbortSignal.timeout` (a total limit, right for short API
 * calls) unless the caller supplies its own `signal` — used for transfers that
 * need an idle timeout instead (see `core/download.ts`).
 * @param input     The URL to request.
 * @param init      Standard `fetch` options; a `signal` here replaces the default one.
 * @param defaultMs The timeout to use when the user didn't pass `--timeout`.
 * @return The fetch response.
 */
export function timedFetch(
	input: string | URL,
	init: RequestInit = {},
	defaultMs = 20_000
): Promise< Response > {
	return fetch( input, {
		...init,
		signal:
			init.signal ?? AbortSignal.timeout( resolveTimeout( defaultMs ) ),
	} );
}
