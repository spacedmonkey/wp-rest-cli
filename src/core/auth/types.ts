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
 * The `wp auth` type slug for WordPress core Application Passwords — matches
 * the literal key WordPress's own REST API root index uses in its
 * `authentication` object (see `core/indexer.ts`'s
 * `getApplicationPasswordAuthorizationUrl`). A future auth mechanism (e.g.
 * OAuth2) would name itself the same way, keyed off whatever its own
 * advertisement mechanism calls itself.
 */
export const APPLICATION_PASSWORDS_AUTH_TYPE = 'application-passwords';

/**
 * Auth types `wp auth <type> ...` can actually dispatch to today. A real
 * (if currently single-member) union rather than a bare `string`, so adding a
 * second type later and updating `commands/auth.ts`'s `runAuthCommand` switch
 * to handle it is enforced by TypeScript's exhaustiveness checking, not just
 * a comment.
 */
export type AuthType = typeof APPLICATION_PASSWORDS_AUTH_TYPE;

/**
 * Auth type names that are recognized but not yet implemented — used only to
 * give `wp auth <type> ...` a friendlier "planned, not built yet" error for
 * these specific names, instead of a generic "unknown type" message.
 */
export const RESERVED_AUTH_TYPES = [ 'oauth2' ] as const;
