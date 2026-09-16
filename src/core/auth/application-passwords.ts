/**
 * Internal dependencies
 */
import type { WpRestClient } from '../client.js';

const REQUEST_TIMEOUT_MS = 8000;

/** An Application Password as reported by WordPress's introspect endpoint. */
export interface IntrospectedApplicationPassword {
	uuid: string;
	appId: string | null;
	name: string;
	created: number;
	lastUsed: number | null;
	lastIp: string | null;
}

/** The raw, snake_case shape WordPress's introspect endpoint responds with. */
interface RawApplicationPassword {
	uuid: string;
	app_id: string | null;
	name: string;
	created: number;
	last_used: number | null;
	last_ip: string | null;
}

/**
 * Introspects the Application Password authenticating the given client, if
 * any. Never throws: a wrong credential, a real account password (which this
 * endpoint doesn't recognize as an Application Password), a network error,
 * or anything else all resolve to `undefined` rather than rejecting —
 * callers rely on this to treat "not an app password" as a normal, silent
 * case.
 * @param client  The authenticated REST client to introspect.
 * @param apiRoot The resolved REST API root URL.
 * @return The introspected Application Password's details, or `undefined` if
 *         the client isn't authenticating with one (or the check failed).
 */
export async function introspectApplicationPassword(
	client: WpRestClient,
	apiRoot: string
): Promise< IntrospectedApplicationPassword | undefined > {
	try {
		const url = new URL(
			'wp/v2/users/me/application-passwords/introspect',
			apiRoot
		).toString();
		const { body } = await client.request< RawApplicationPassword >( url, {
			timeoutMs: REQUEST_TIMEOUT_MS,
		} );
		return {
			uuid: body.uuid,
			appId: body.app_id,
			name: body.name,
			created: body.created,
			lastUsed: body.last_used,
			lastIp: body.last_ip,
		};
	} catch {
		return undefined;
	}
}

/**
 * Revokes a single Application Password by uuid. Never throws: any failure
 * (wrong credential, the password already gone, a network error, a site
 * that doesn't support this endpoint) resolves to `false` rather than
 * rejecting.
 * IMPORTANT: this always targets the single-uuid route. It must never be
 * changed to call the bulk `wp/v2/users/me/application-passwords` route
 * (no uuid) — that revokes every Application Password for the user.
 * @param client  The authenticated REST client to issue the revocation with.
 * @param apiRoot The resolved REST API root URL.
 * @param uuid    The uuid of the Application Password to revoke.
 * @return Whether the revocation succeeded.
 */
export async function revokeApplicationPassword(
	client: WpRestClient,
	apiRoot: string,
	uuid: string
): Promise< boolean > {
	try {
		const url = new URL(
			`wp/v2/users/me/application-passwords/${ encodeURIComponent(
				uuid
			) }`,
			apiRoot
		).toString();
		await client.request( url, {
			method: 'DELETE',
			timeoutMs: REQUEST_TIMEOUT_MS,
		} );
		return true;
	} catch {
		return false;
	}
}
