/**
 * Abstraction over "how do we authenticate an outgoing request", so alternative
 * auth methods (OAuth, cookie+nonce, etc.) can be added later without touching
 * call sites in the HTTP client.
 */
export interface AuthProvider {
	/** @return Headers to merge into an outgoing request to authenticate it. */
	getHeaders: () => Promise< Record< string, string > >;
}
