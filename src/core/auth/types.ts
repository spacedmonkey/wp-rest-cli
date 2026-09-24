/**
 * Abstraction over "how do we authenticate an outgoing request", so alternative
 * auth methods (OAuth, cookie+nonce, etc.) can be added later without touching
 * call sites in the HTTP client.
 */
export interface AuthProvider {
	/** @return Headers to merge into an outgoing request to authenticate it. */
	getHeaders: () => Promise< Record< string, string > >;
}

/**
 * The `wrapido auth` type slug for WordPress core Application Passwords — matches
 * the literal key WordPress's own REST API root index uses in its
 * `authentication` object (see `core/indexer.ts`'s
 * `getApplicationPasswordAuthorizationUrl`).
 */
export const APPLICATION_PASSWORDS_AUTH_TYPE = 'application-passwords';

/**
 * The `wrapido auth` type slug for the WP-API/OAuth2 plugin — matches the literal
 * key that plugin's `register_in_index()` uses in the site's `authentication`
 * object (see `core/indexer.ts`'s `getOAuth2Endpoints`).
 */
export const OAUTH2_AUTH_TYPE = 'oauth2';

/**
 * Auth types `wrapido auth <type> ...` can actually dispatch to. A real TypeScript
 * union rather than a bare `string`, so adding a further type later and
 * updating `commands/auth.ts`'s `runAuthCommand` switch to handle it is
 * enforced by TypeScript's exhaustiveness checking, not just a comment.
 */
export type AuthType =
	| typeof APPLICATION_PASSWORDS_AUTH_TYPE
	| typeof OAUTH2_AUTH_TYPE;
