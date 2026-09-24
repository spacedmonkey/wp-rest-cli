/**
 * External dependencies
 */
import {
	createServer,
	type Server,
	type IncomingMessage,
	type ServerResponse,
} from 'node:http';

export interface Fixture {
	server: Server;
	baseUrl: string;
	close: () => Promise< void >;
}

/** Responses to requests carrying `?_envelope`, wrapped by {@link send} like WordPress does. */
const enveloped = new WeakSet< ServerResponse >();

function send(
	res: ServerResponse,
	status: number,
	body?: unknown,
	headers: Record< string, string > = {}
): void {
	if ( enveloped.has( res ) ) {
		// Like WP_REST_Server::envelope_response: real status/headers move
		// into the body; the HTTP response itself is a plain 200. The
		// `x-qm-fixture` header stands in for a plugin (Query Monitor) header
		// that only exists on the real HTTP response.
		res.writeHead( 200, {
			'content-type': 'application/json',
			'x-qm-fixture': 'plugin-header',
			'set-cookie': 'session=SECRET-COOKIE',
		} );
		res.end(
			JSON.stringify( {
				body: body ?? null,
				status,
				headers: { 'Content-Type': 'application/json', ...headers },
			} )
		);
		return;
	}
	res.writeHead( status, {
		'content-type': 'application/json',
		...headers,
	} );
	res.end( body === undefined ? undefined : JSON.stringify( body ) );
}

async function readBody(
	req: IncomingMessage
): Promise< Record< string, unknown > > {
	const chunks: Buffer[] = [];
	for await ( const chunk of req ) {
		chunks.push( chunk as Buffer );
	}
	const text = Buffer.concat( chunks ).toString( 'utf8' );
	return text ? JSON.parse( text ) : {};
}

/**
 * Extracts plain text from a `title`/`content`/`excerpt`-shaped POST body
 * value, the way real WordPress's post-type controllers do: a plain string
 * is accepted directly, and the full `{raw, rendered}` object shape (which
 * `title`/`content`/`excerpt` are declared as in the OPTIONS schema) is
 * accepted too, reading its `raw` sub-value. Anything else is treated as
 * empty, matching WordPress's own `empty_content` rejection.
 *
 * @param value The raw `title`/`content`/`excerpt` value from a POST body.
 * @return The plain text, or `''` if `value` carries none.
 */
function extractRawText( value: unknown ): string {
	if ( typeof value === 'string' ) {
		return value;
	}
	if ( value && typeof value === 'object' && 'raw' in value ) {
		const { raw } = value as { raw: unknown };
		return typeof raw === 'string' ? raw : '';
	}
	return '';
}

/**
 * Parses an `Authorization: Basic <base64>` request header into its
 * decoded username/password, shared by the three `users/me` routes below.
 *
 * @param req The incoming request.
 * @return The decoded credential, or `null` if no valid Basic Auth header
 *         was sent.
 */
function parseBasicAuth(
	req: IncomingMessage
): { username: string; password: string } | null {
	const header = req.headers.authorization;
	if ( ! header || ! header.startsWith( 'Basic ' ) ) {
		return null;
	}
	const decoded = Buffer.from(
		header.slice( 'Basic '.length ),
		'base64'
	).toString( 'utf8' );
	const separatorIndex = decoded.indexOf( ':' );
	if ( separatorIndex === -1 ) {
		return null;
	}
	return {
		username: decoded.slice( 0, separatorIndex ),
		password: decoded.slice( separatorIndex + 1 ),
	};
}

const widgets = new Map< number, Record< string, unknown > >( [
	[
		1,
		{
			id: 1,
			title: { rendered: 'First widget' },
			link: '/widgets/1',
			meta: {},
		},
	],
] );
let nextId = 2;

// Synthetic fixture, not modelled on any real WordPress controller — exists
// purely so `generate` integration tests have required fields with a
// `format` (email) and an `integer` type to exercise smart-default
// synthesis against, without touching `widgets`' own schema/tests.
const subscribers = new Map< number, Record< string, unknown > >();
let nextSubscriberId = 1;

// Modelled on WP_REST_Posts_Controller: title/content/excerpt are all
// declared `required: false` in the schema (matching real WordPress core),
// yet POST still rejects a body where all three are empty — a plain-PHP
// check in create_item(), not expressed in the schema at all. Exists so
// `generate` integration tests can exercise the 'empty_content' retry path.
const articles = new Map< number, Record< string, unknown > >();
let nextArticleId = 1;

// Modelled on WP_REST_Users_Controller: `username`'s live schema is bare
// {type: 'string', required: true} — no pattern/format at all — yet
// WordPress's own validate_username() rejects a generic freeform-text
// placeholder in practice. Exists so `generate` integration tests can
// exercise the identifier-field (username/slug) synthesis path.
const members = new Map< number, Record< string, unknown > >();
let nextMemberId = 1;

// Modelled on WP_REST_Comments_Controller: `content`'s live schema is
// `required: false` (matching real WordPress core — same {raw, rendered}
// object shape as posts' title/content), yet POST unconditionally rejects
// an empty one with 'rest_comment_content_invalid' — unlike posts'
// 'empty_content', there's no other field that can substitute for it.
// Exists so `generate` integration tests can exercise a second entry in
// HIDDEN_REQUIRED_FIELDS_BY_ERROR_CODE (rest.ts), not just 'empty_content'.
const remarks = new Map< number, Record< string, unknown > >();
let nextRemarkId = 1;

// Modelled on WP_REST_Widgets_Controller: `id_base`'s live schema is
// `{type: 'string', required: false}` — no hint it's needed at all — yet
// POST rejects an item lacking it with 'rest_invalid_widget'. Unlike every
// other hidden-required-field case, there's no placeholder text that could
// possibly satisfy this: a widget type has to really exist, discoverable
// only via the sibling `widget-types` collection (`rest.ts`'s
// `resolveWidgetIdBase` fetches that fixed, real-WordPress route name —
// not one derived from the generated route — so this fixture's sibling
// route has to be named `widget-types` too, even though the "widgets"
// route itself is named `gadgets` here to avoid colliding with the
// existing `widgets` fixture). `sidebar` is `required: true` *with* a
// `default` (matching real WordPress core's own odd-looking combination)
// — exercises `generateDefaultValue`'s default-takes-priority-over-
// required-ness path end-to-end alongside the id_base lookup.
const gadgets = new Map< number, Record< string, unknown > >();
let nextGadgetId = 1;
const WIDGET_TYPES = [
	{ id: 'search', name: 'Search' },
	{ id: 'text', name: 'Text' },
];

const settings: Record< string, unknown > = { title: 'Fixture Site' };

// Uuids "revoked" via DELETE /wp-json/wp/v2/users/me/application-passwords/:uuid
// below, so tests can assert a specific uuid was revoked without the fixture
// exposing any broader state.
const revokedUuids = new Set< string >();

/**
 * Exposes the set of application-password uuids revoked so far via the
 * fixture's DELETE /wp-json/wp/v2/users/me/application-passwords/:uuid route,
 * for integration tests to assert against.
 *
 * @return The live (mutable) set of revoked uuids.
 */
export function getRevokedApplicationPasswordUuids(): Set< string > {
	return revokedUuids;
}

// Reserved OAuth2 client ids, collected here for the same reason the
// users/me/introspect/DELETE sentinels above are:
//   - 'test-client-id'        → succeeds for both authorization_code and
//                                client_credentials.
//   - 'test-client-id-deny'   → GET /oauth2-authorize simulates the user
//                                cancelling the consent screen (the only case
//                                that redirects on error, per the real
//                                plugin's behavior).
//   - 'test-client-id-no-cc'  → succeeds for authorization_code, but the
//                                token endpoint 401s it for
//                                client_credentials specifically — models an
//                                Application that doesn't have the
//                                "Client Credentials Grant" setting enabled
//                                (oauth2.endpoints.token.invalid_client).
//   - 'test-client-id-wrong-code-path' (client_credentials/`add` only, not
//     listed in KNOWN_OAUTH2_CLIENT_IDS below since it never goes through
//     GET /oauth2-authorize) → the token endpoint responds as though the
//     request fell through to authorization_code validation instead
//     (rest_missing_callback_param) — models a site whose deployed
//     WP-API/OAuth2 code doesn't actually route client_credentials to its
//     own handler at all (outdated plugin, stale opcode cache, a WAF).
// Any other client_id is "unknown" — GET /oauth2-authorize refuses it with a
// plain (non-redirect) error, matching the real plugin's wp_die() (it can't
// safely redirect to an unvalidated redirect_uri in the first place).
const KNOWN_OAUTH2_CLIENT_IDS = [
	'test-client-id',
	'test-client-id-deny',
	'test-client-id-no-cc',
];

// One-time authorization codes issued by GET /oauth2-authorize, consumed by
// POST /wp-json/oauth2/access_token's authorization_code grant.
const oauth2Codes = new Map<
	string,
	{ clientId: string; redirectUri: string }
>();
let oauth2CodeCounter = 0;

// Access tokens issued by the token endpoint (either grant) — used by
// GET /wp-json/wp/v2/users/me to recognize a Bearer token as authenticated,
// modelling a client_credentials token's lack of real user context (id 0).
const oauth2AccessTokens = new Set< string >();
let oauth2TokenCounter = 0;

// A personal access token, as though generated by hand in wp-admin (not
// issued by either token-endpoint grant above, so it's a fixed sentinel
// rather than something the fixture mints) — recognized by
// GET /wp-json/wp/v2/users/me with a *real* user identity, unlike a
// client_credentials token's id-0 context. Any other Bearer token not in
// `oauth2AccessTokens` either is "unrecognized", modelling an invalid/expired
// personal token — that route's existing 401 fallback already covers it.
const KNOWN_PERSONAL_TOKEN = 'test-personal-token-valid';

// Hit counters for the two OAuth2 routes below, so a test can assert neither
// was ever reached — e.g. when discovery-gating should have blocked the CLI
// before any network call to them at all.
const oauth2RouteHits = { authorize: 0, token: 0 };

/**
 * Exposes how many times GET /oauth2-authorize and POST
 * /wp-json/oauth2/access_token have been hit so far, for integration tests
 * to assert against (typically that a count did NOT increase across some
 * action, e.g. discovery-gating refusing to proceed at all).
 *
 * @return A snapshot of the current hit counts.
 */
export function getOAuth2RouteHitCounts(): {
	authorize: number;
	token: number;
} {
	return { ...oauth2RouteHits };
}

/**
 * Parses a `application/x-www-form-urlencoded` request body — distinct from
 * `readBody()` above, which unconditionally `JSON.parse`s and would throw on
 * this shape. The OAuth2 token endpoint below is the only fixture route that
 * receives a form-encoded body (mirroring the real WP-API/OAuth2 plugin's
 * token endpoint), so this parser is scoped to just that route rather than
 * generalizing `readBody()` to sniff `Content-Type`.
 *
 * @param req The incoming request.
 * @return The parsed form fields.
 */
async function readFormBody(
	req: IncomingMessage
): Promise< URLSearchParams > {
	const chunks: Buffer[] = [];
	for await ( const chunk of req ) {
		chunks.push( chunk as Buffer );
	}
	return new URLSearchParams( Buffer.concat( chunks ).toString( 'utf8' ) );
}

/** One multipart upload the fixture received, for assertions. */
export interface ReceivedUpload {
	path: string;
	method: string;
	fields: Record< string, string >;
	files: Array< { field: string; name: string; type: string; size: number } >;
	contentLength: number;
}

const receivedUploads: ReceivedUpload[] = [];
const postProcessHits = new Map< number, number >();
const deletedMediaIds: number[] = [];
const downloadRequests: Array< { path: string; authorization?: string } > = [];
let nextMediaId = 100;

/** @return Every multipart upload received so far (media + custom routes). */
export function getReceivedUploads(): ReceivedUpload[] {
	return receivedUploads;
}

/** @return How many times each attachment id's post-process route was hit. */
export function getPostProcessHits(): Map< number, number > {
	return postProcessHits;
}

/** @return Attachment ids removed via `DELETE ...?force=true`. */
export function getDeletedMediaIds(): number[] {
	return deletedMediaIds;
}

/** @return Every request the `/downloads/*` routes received, with its Authorization header. */
export function getDownloadRequests(): typeof downloadRequests {
	return downloadRequests;
}

/**
 * Parses a multipart/form-data request body using the platform's own parser.
 *
 * @param req The incoming request.
 * @return The text fields and files, plus the raw byte length.
 */
async function readMultipart( req: IncomingMessage ): Promise< {
	fields: Record< string, string >;
	files: ReceivedUpload[ 'files' ];
	contentLength: number;
} > {
	const chunks: Buffer[] = [];
	for await ( const chunk of req ) {
		chunks.push( chunk as Buffer );
	}
	const buffer = Buffer.concat( chunks );
	const form = await new Request( 'http://localhost/', {
		method: 'POST',
		headers: { 'content-type': String( req.headers[ 'content-type' ] ) },
		body: buffer,
	} ).formData();
	const fields: Record< string, string > = {};
	const files: ReceivedUpload[ 'files' ] = [];
	for ( const [ field, value ] of form.entries() ) {
		if ( typeof value === 'string' ) {
			fields[ field ] = value;
		} else {
			files.push( {
				field,
				name: value.name,
				type: value.type,
				size: value.size,
			} );
		}
	}
	return { fields, files, contentLength: buffer.length };
}

export async function startFixture(): Promise< Fixture > {
	const server = createServer( async ( req, res ) => {
		const url = new URL( req.url ?? '/', 'http://localhost' );
		const path = url.pathname;
		if ( url.searchParams.has( '_envelope' ) ) {
			enveloped.add( res );
		}
		// `?slow=<ms>` delays any response, for exercising --timeout.
		const slowMs = Number( url.searchParams.get( 'slow' ) );
		if ( slowMs > 0 ) {
			await new Promise( ( resolve ) => setTimeout( resolve, slowMs ) );
		}

		if ( req.method === 'HEAD' && path === '/' ) {
			res.writeHead( 200, {
				link: `<${ baseUrlHolder.value }/wp-json/>; rel="https://api.w.org/"`,
			} );
			res.end();
			return;
		}

		// Same HEAD-discovery Link header, but pointed at the "no Application
		// Passwords" index below instead — `new URL('/wp-json/', base)` (the
		// conventional-path discovery fallback) always resolves against the
		// origin root regardless of `base`'s own path, so a sub-path variant
		// can only be discovered via this HEAD Link header, not the fallback.
		if ( req.method === 'HEAD' && path === '/no-app-passwords' ) {
			res.writeHead( 200, {
				link: `<${ baseUrlHolder.value }/no-app-passwords/wp-json/>; rel="https://api.w.org/"`,
			} );
			res.end();
			return;
		}

		// A second, otherwise-identical site index, addressed as
		// `${baseUrl}/no-app-passwords`, that omits the `authentication` field
		// entirely — for exercising `wp auth application-passwords login`
		// against a site that doesn't support Application Passwords at all
		// (as opposed to the
		// main fixture above, which always advertises support).
		if ( path === '/no-app-passwords/wp-json/' ) {
			send( res, 200, {
				name: 'Fixture Site (no Application Passwords)',
				namespaces: [ 'wp/v2' ],
				routes: {},
			} );
			return;
		}

		if ( path === '/wp-json/' || path === '/wp-json' ) {
			send( res, 200, {
				name: 'Fixture Site',
				namespaces: [ 'wp/v2' ],
				authentication: {
					'application-passwords': {
						endpoints: {
							authorization:
								'/wp-admin/authorize-application.php',
						},
					},
					// Deliberately omits 'client_credentials' from
					// grant_types, matching the real WP-API/OAuth2 plugin's
					// behavior — it only ever lists the grants registered
					// against its browser-authorize Types\Type interface
					// (authorization_code/implicit), never the
					// client_credentials special case in its token endpoint,
					// even when that grant is fully enabled for a client.
					// Exercises that the CLI's discovery gating keys off
					// endpoints.token presence, not grant_types.
					oauth2: {
						endpoints: {
							authorization: '/oauth2-authorize',
							token: '/wp-json/oauth2/access_token',
						},
						grant_types: [ 'authorization_code', 'implicit' ],
					},
				},
				routes: {
					'/': { namespace: '', methods: [ 'GET' ], endpoints: [] },
					'/wp/v2/widgets': {
						namespace: 'wp/v2',
						methods: [ 'GET', 'POST' ],
						endpoints: [
							{ methods: [ 'GET' ] },
							{ methods: [ 'POST' ] },
						],
					},
					'/wp/v2/widgets/(?P<id>[\\d]+)': {
						namespace: 'wp/v2',
						methods: [ 'GET', 'PUT', 'DELETE' ],
						endpoints: [
							{ methods: [ 'GET' ] },
							{ methods: [ 'PUT' ] },
							{ methods: [ 'DELETE' ] },
						],
					},
					'/wp/v2/media': {
						namespace: 'wp/v2',
						methods: [ 'GET', 'POST' ],
						endpoints: [
							{ methods: [ 'GET' ] },
							{ methods: [ 'POST' ] },
						],
					},
					'/wp/v2/attachments-custom': {
						namespace: 'wp/v2',
						methods: [ 'POST' ],
						endpoints: [ { methods: [ 'POST' ] } ],
					},
					'/wp/v2/plain-uploads': {
						namespace: 'wp/v2',
						methods: [ 'POST' ],
						endpoints: [ { methods: [ 'POST' ] } ],
					},
					'/wp/v2/subscribers': {
						namespace: 'wp/v2',
						methods: [ 'GET', 'POST' ],
						endpoints: [
							{ methods: [ 'GET' ] },
							{ methods: [ 'POST' ] },
						],
					},
					'/wp/v2/articles': {
						namespace: 'wp/v2',
						methods: [ 'GET', 'POST' ],
						endpoints: [
							{ methods: [ 'GET' ] },
							{ methods: [ 'POST' ] },
						],
					},
					'/wp/v2/members': {
						namespace: 'wp/v2',
						methods: [ 'GET', 'POST' ],
						endpoints: [
							{ methods: [ 'GET' ] },
							{ methods: [ 'POST' ] },
						],
					},
					'/wp/v2/remarks': {
						namespace: 'wp/v2',
						methods: [ 'GET', 'POST' ],
						endpoints: [
							{ methods: [ 'GET' ] },
							{ methods: [ 'POST' ] },
						],
					},
					'/wp/v2/gadgets': {
						namespace: 'wp/v2',
						methods: [ 'GET', 'POST' ],
						endpoints: [
							{ methods: [ 'GET' ] },
							{ methods: [ 'POST' ] },
						],
					},
					'/wp/v2/widget-types': {
						namespace: 'wp/v2',
						methods: [ 'GET' ],
						endpoints: [ { methods: [ 'GET' ] } ],
					},
					'/wp/v2/taxonomies': {
						namespace: 'wp/v2',
						methods: [ 'GET' ],
						endpoints: [ { methods: [ 'GET' ] } ],
					},
					// Modelled on WP_REST_Global_Styles_Controller: no bare collection
					// route exists here at all, only this parameterised one.
					'/wp/v2/global-styles/themes/(?P<stylesheet>%s)': {
						namespace: 'wp/v2',
						methods: [ 'GET' ],
						endpoints: [
							{
								methods: [ 'GET' ],
								args: {
									// WordPress core declares a route's own URL parameter as
									// required: false in its schema (it's filled from the URL
									// match, not validated as caller input) even though it's
									// never actually optional — modelled here to exercise that.
									stylesheet: {
										type: 'string',
										description: 'The theme identifier',
										required: false,
									},
									context: {
										type: 'string',
										enum: [ 'view', 'edit', 'embed' ],
										default: 'view',
										required: false,
									},
								},
							},
						],
					},
					// Synthetic fixture modelled on Yoast SEO's `yoast/v1/file_size`
					// route: a bare GET collection whose only arg is `url`, and it's
					// required — exercises local validation of a `required` GET/`list`
					// arg (as opposed to a `create`/POST one).
					'/wp/v2/file-size': {
						namespace: 'wp/v2',
						methods: [ 'GET' ],
						endpoints: [ { methods: [ 'GET' ] } ],
					},
					// Modelled on WP_REST_Settings_Controller: a singleton resource with
					// no <id> at all — GET/POST/PUT/PATCH all act on this one bare path,
					// and there's no `/settings/(?P<id>)` sibling.
					'/wp/v2/settings': {
						namespace: 'wp/v2',
						methods: [ 'GET', 'POST', 'PUT', 'PATCH' ],
						endpoints: [
							{ methods: [ 'GET', 'POST', 'PUT', 'PATCH' ] },
						],
					},
					// Synthetic fixture, not modelled on any real WordPress controller —
					// exists purely to exercise route navigation three literal segments
					// deep (gizmos -> parts -> electronic), beyond the two-segment
					// global-styles/themes case above.
					'/wp/v2/gizmos/parts/electronic/(?P<id>[\\d]+)': {
						namespace: 'wp/v2',
						methods: [ 'GET' ],
						endpoints: [
							{
								methods: [ 'GET' ],
								args: {
									context: {
										type: 'string',
										enum: [ 'view', 'edit', 'embed' ],
										default: 'view',
										required: false,
									},
								},
							},
						],
					},
					// Modelled on WP_REST_Revisions_Controller: the URL parameter sits
					// in the *middle* of the path (a parent post id), not at the end —
					// addressed as `wp wp/v2 posts revisions get <parent>`.
					'/wp/v2/posts/(?P<parent>[\\d]+)/revisions': {
						namespace: 'wp/v2',
						methods: [ 'GET' ],
						endpoints: [
							{
								methods: [ 'GET' ],
								args: {
									// Same required: false-despite-being-mandatory convention
									// as the "stylesheet" arg above, for the mid-path case.
									parent: {
										type: 'integer',
										description:
											'The ID for the parent of the revision.',
										required: false,
									},
								},
							},
						],
					},
					// Modelled on WP_REST_Revisions_Controller's single-revision
					// endpoint: TWO URL parameters (parent post id, then revision id) —
					// addressed as `wp wp/v2 posts revisions <parent> <id>` (no verb;
					// this is the multi-parameter case, unlike every single-parameter
					// route above which needs get/exists).
					'/wp/v2/posts/(?P<parent>[\\d]+)/revisions/(?P<id>[\\d]+)':
						{
							namespace: 'wp/v2',
							methods: [ 'GET' ],
							endpoints: [ { methods: [ 'GET' ] } ],
						},
					// Modelled on WP_REST_Global_Styles_Revisions_Controller's sibling
					// (real WP's .../themes/<stylesheet>/variations): a mid-path
					// parameter *and* a hybrid node — "global-styles/themes" is both
					// directly addressable (the themes route above) and has this as a
					// child.
					'/wp/v2/global-styles/themes/(?P<stylesheet>%s)/variations':
						{
							namespace: 'wp/v2',
							methods: [ 'GET' ],
							endpoints: [ { methods: [ 'GET' ] } ],
						},
				},
			} );
			return;
		}

		// Simulates the WP-API/OAuth2 plugin's non-REST wp-login.php authorize
		// step. A real invocation of this requires a logged-in wp-admin session
		// and a nonce-protected consent form — this fixture necessarily
		// simplifies that away to just the two outcomes the CLI's own flow
		// needs to exercise: approve (redirect with a code) or cancel (redirect
		// with error=access_denied). An unknown client_id/missing redirect_uri
		// never redirects at all, matching the real plugin's wp_die() — it
		// can't safely redirect to an unvalidated URI in the first place.
		if ( path === '/oauth2-authorize' && req.method === 'GET' ) {
			oauth2RouteHits.authorize++;
			const clientId = url.searchParams.get( 'client_id' );
			const redirectUri = url.searchParams.get( 'redirect_uri' );
			const state = url.searchParams.get( 'state' ) ?? '';
			if (
				! clientId ||
				! redirectUri ||
				! KNOWN_OAUTH2_CLIENT_IDS.includes( clientId )
			) {
				res.writeHead( 400, { 'content-type': 'text/plain' } );
				res.end( 'invalid client_id or redirect_uri' );
				return;
			}
			if ( clientId === 'test-client-id-deny' ) {
				const denyUrl = new URL( redirectUri );
				denyUrl.searchParams.set( 'error', 'access_denied' );
				denyUrl.searchParams.set( 'state', state );
				res.writeHead( 302, { location: denyUrl.toString() } );
				res.end();
				return;
			}
			const code = `code-${ ++oauth2CodeCounter }`;
			oauth2Codes.set( code, { clientId, redirectUri } );
			const successUrl = new URL( redirectUri );
			successUrl.searchParams.set( 'code', code );
			successUrl.searchParams.set( 'state', state );
			res.writeHead( 302, { location: successUrl.toString() } );
			res.end();
			return;
		}

		// Simulates the plugin's token endpoint. Real requests here are
		// form-encoded (application/x-www-form-urlencoded), not JSON — see
		// `readFormBody()`.
		if (
			path === '/wp-json/oauth2/access_token' &&
			req.method === 'POST'
		) {
			oauth2RouteHits.token++;
			const body = await readFormBody( req );
			const grantType = body.get( 'grant_type' );

			if ( grantType === 'authorization_code' ) {
				const code = body.get( 'code' );
				const clientId = body.get( 'client_id' );
				const redirectUri = body.get( 'redirect_uri' );
				const issued = code ? oauth2Codes.get( code ) : undefined;
				if (
					! issued ||
					issued.clientId !== clientId ||
					issued.redirectUri !== redirectUri
				) {
					send( res, 400, { error: 'invalid_grant' } );
					return;
				}
				oauth2Codes.delete( code as string ); // one-time use
				const token = `oauth2-token-${ ++oauth2TokenCounter }`;
				oauth2AccessTokens.add( token );
				send( res, 200, {
					access_token: token,
					token_type: 'bearer',
				} );
				return;
			}

			if ( grantType === 'client_credentials' ) {
				const basicAuth = parseBasicAuth( req );
				const clientId =
					basicAuth?.username ?? body.get( 'client_id' ) ?? undefined;
				const clientSecret =
					basicAuth?.password ??
					body.get( 'client_secret' ) ??
					undefined;
				// Below, error bodies match the real plugin's actual shape —
				// WordPress's REST framework always serializes a route
				// callback's returned `WP_Error` as `{code, message, data}`,
				// never a bare OAuth2-style `{error: "..."}` — so the CLI's
				// own error-code-based diagnosis (`core/auth/oauth2.ts`) is
				// exercised the same way a real site's response would.
				if ( ! clientId || ! clientSecret ) {
					send( res, 400, {
						code: 'oauth2.endpoints.token.invalid_request',
						message: 'Client credentials not provided.',
						data: { status: 400 },
					} );
					return;
				}
				// Models an Application without the "Client Credentials
				// Grant" setting enabled in wp-admin — the plugin's own
				// handle_client_credentials() deliberately collapses
				// "unknown client_id", "wrong secret", and "grant disabled"
				// into this one generic 401.
				if ( clientId === 'test-client-id-no-cc' ) {
					send( res, 401, {
						code: 'oauth2.endpoints.token.invalid_client',
						message: 'Client authentication failed.',
						data: { status: 401 },
					} );
					return;
				}
				// Models a site whose deployed WP-API/OAuth2 code doesn't
				// actually route client_credentials to its own handler (an
				// outdated plugin build, a stale opcode cache, or a
				// proxy/WAF) — the request instead falls through to the
				// plugin's authorization_code validation, which reports
				// `code` missing since client_credentials never sends one.
				if ( clientId === 'test-client-id-wrong-code-path' ) {
					send( res, 400, {
						code: 'rest_missing_callback_param',
						message: 'Missing parameter(s): code',
						data: { status: 400, params: [ 'code' ] },
					} );
					return;
				}
				const token = `oauth2-token-${ ++oauth2TokenCounter }`;
				oauth2AccessTokens.add( token );
				send( res, 200, {
					access_token: token,
					token_type: 'bearer',
				} );
				return;
			}

			send( res, 400, { error: 'unsupported_grant_type' } );
			return;
		}

		// --- File upload fixtures -------------------------------------------
		// The block-editor settings route (Gutenberg plugin): which state it
		// reports is chosen by the Basic-auth username, since one fixture
		// instance serves a whole test file.
		if ( path === '/wp-json/wp-block-editor/v1/settings' ) {
			const user = parseBasicAuth( req )?.username;
			if ( user === 'forbidden' ) {
				send( res, 403, {
					code: 'rest_cannot_read_block_editor_settings',
					message:
						'Sorry, you are not allowed to read the block editor settings.',
					data: { status: 403 },
				} );
			} else if ( user === 'mimeuser' ) {
				send( res, 200, {
					allowedMimeTypes: {
						'jpg|jpeg|jpe': 'image/jpeg',
						png: 'image/png',
						pdf: 'application/pdf',
					},
					maxUploadFileSize: 1000,
				} );
			} else {
				send( res, 404, {
					code: 'rest_no_route',
					message:
						'No route was found matching the URL and request method.',
					data: { status: 404 },
				} );
			}
			return;
		}

		if ( path === '/wp-json/wp/v2/media' && req.method === 'OPTIONS' ) {
			send( res, 200, {
				namespace: 'wp/v2',
				methods: [ 'GET', 'POST' ],
				endpoints: [
					{ methods: [ 'GET' ], args: {} },
					{
						methods: [ 'POST' ],
						args: {
							title: {
								type: 'string',
								description: 'The title.',
							},
							alt_text: {
								type: 'string',
								description: 'Alt text.',
							},
							caption: {
								type: 'string',
								description: 'Caption.',
							},
						},
					},
				],
			} );
			return;
		}

		if (
			path === '/wp-json/wp/v2/plain-uploads' &&
			req.method === 'OPTIONS'
		) {
			// Like a real custom route: the file arg carries no schema hint.
			send( res, 200, {
				namespace: 'wp/v2',
				methods: [ 'POST' ],
				endpoints: [
					{
						methods: [ 'POST' ],
						args: {
							attachment: { type: 'string' },
							title: { type: 'string' },
							link: { type: 'string', format: 'uri' },
						},
					},
				],
			} );
			return;
		}

		if (
			path === '/wp-json/wp/v2/attachments-custom' &&
			req.method === 'OPTIONS'
		) {
			send( res, 200, {
				namespace: 'wp/v2',
				methods: [ 'POST' ],
				endpoints: [
					{
						methods: [ 'POST' ],
						args: {
							attachment: {
								type: 'string',
								format: 'binary',
								required: true,
								description: 'The file to attach.',
							},
							title: {
								type: 'string',
								description: 'The title.',
							},
						},
					},
				],
			} );
			return;
		}

		if (
			( path === '/wp-json/wp/v2/media' ||
				path === '/wp-json/wp/v2/attachments-custom' ||
				path === '/wp-json/wp/v2/plain-uploads' ) &&
			req.method === 'POST'
		) {
			if (
				! /multipart\/form-data/.test(
					req.headers[ 'content-type' ] ?? ''
				)
			) {
				send( res, 400, {
					code: 'rest_upload_no_data',
					message: 'No data supplied.',
					data: { status: 400 },
				} );
				return;
			}
			const upload = await readMultipart( req );
			receivedUploads.push( {
				path,
				method: req.method,
				fields: upload.fields,
				files: upload.files,
				contentLength: upload.contentLength,
			} );
			if ( upload.files.some( ( f ) => f.name === 'stall.png' ) ) {
				// Sentinel: hold the response so --timeout's idle limit fires.
				await new Promise( ( resolve ) => setTimeout( resolve, 3000 ) );
			}
			const expected = /attachments-custom|plain-uploads/.test( path )
				? 'attachment'
				: 'file';
			const file = upload.files.find( ( f ) => f.field === expected );
			if ( ! file ) {
				send( res, 400, {
					code: 'rest_upload_no_data',
					message: 'No data supplied.',
					data: { status: 400 },
				} );
				return;
			}
			if ( file.name === '413.bin' ) {
				res.writeHead( 413, { 'content-type': 'text/html' } );
				res.end(
					'<html><head><title>413 Request Entity Too Large</title></head><body><center><h1>413 Request Entity Too Large</h1></center></body></html>'
				);
				return;
			}
			if ( file.name === 'noperm.bin' ) {
				send( res, 500, {
					code: 'rest_upload_unknown_error',
					message:
						'Sorry, you are not allowed to upload this file type.',
					data: { status: 500 },
				} );
				return;
			}
			if ( file.name === 'crash.png' || file.name === 'recover.png' ) {
				const id = file.name === 'crash.png' ? 77 : 78;
				res.writeHead( 500, {
					'content-type': 'application/json',
					'x-wp-upload-attachment-id': String( id ),
				} );
				res.end(
					JSON.stringify( {
						code: 'internal_server_error',
						message: 'Internal error.',
						data: { status: 500 },
					} )
				);
				return;
			}
			const id = nextMediaId++;
			// Real WP returns a Location header; only sent on request so the
			// other upload tests keep exercising the no-Location fallback.
			if ( upload.fields.title === 'with-location' ) {
				res.setHeader(
					'location',
					`${ baseUrlHolder.value }/wp-json/wp/v2/media/${ id }`
				);
			}
			send( res, 201, {
				id,
				title: {
					rendered:
						upload.fields.title ??
						file.name.replace( /\.[^.]+$/, '' ),
				},
				source_url: `${ baseUrlHolder.value }/uploads/${ file.name }`,
				mime_type: file.type,
				filename: file.name,
				size: file.size,
			} );
			return;
		}

		const postProcessMatch = path.match(
			/^\/wp-json\/wp\/v2\/media\/(\d+)\/post-process$/
		);
		if ( postProcessMatch && req.method === 'POST' ) {
			const id = Number( postProcessMatch[ 1 ] );
			postProcessHits.set( id, ( postProcessHits.get( id ) ?? 0 ) + 1 );
			if ( id === 78 ) {
				send( res, 200, { id, title: { rendered: 'recovered' } } );
			} else {
				send( res, 500, {
					code: 'internal_server_error',
					message: 'Internal error.',
					data: { status: 500 },
				} );
			}
			return;
		}

		const mediaGetMatch = path.match( /^\/wp-json\/wp\/v2\/media\/(\d+)$/ );
		if ( mediaGetMatch && req.method === 'GET' ) {
			// `fetched` marks the follow-up GET, absent from the POST body.
			send( res, 200, {
				id: Number( mediaGetMatch[ 1 ] ),
				fetched: true,
			} );
			return;
		}

		const mediaDeleteMatch = path.match(
			/^\/wp-json\/wp\/v2\/media\/(\d+)$/
		);
		if ( mediaDeleteMatch && req.method === 'DELETE' ) {
			deletedMediaIds.push( Number( mediaDeleteMatch[ 1 ] ) );
			send( res, 200, { deleted: true } );
			return;
		}

		// Source files for URL uploads.
		if ( path.startsWith( '/downloads/' ) ) {
			downloadRequests.push( {
				path,
				authorization: req.headers.authorization,
			} );
			const body = Buffer.from( 'BINARY-FILE-CONTENT-'.repeat( 50 ) );
			if ( path === '/downloads/cat.jpg' ) {
				res.writeHead( 200, {
					'content-type': 'image/jpeg',
					'content-length': body.length,
				} );
				res.end( body );
			} else if ( path === '/downloads/noext' ) {
				res.writeHead( 200, { 'content-type': 'image/png' } );
				res.end( body );
			} else if ( path === '/downloads/disp' ) {
				res.writeHead( 200, {
					'content-type': 'application/octet-stream',
					'content-disposition': 'attachment; filename="named.png"',
				} );
				res.end( body );
			} else if ( path === '/downloads/redirect' ) {
				res.writeHead( 302, { location: '/downloads/cat.jpg' } );
				res.end();
			} else {
				res.writeHead( 404, { 'content-type': 'text/plain' } );
				res.end( 'Not Found' );
			}
			return;
		}

		if ( path === '/wp-json/wp/v2/widgets' && req.method === 'OPTIONS' ) {
			send( res, 200, {
				namespace: 'wp/v2',
				methods: [ 'GET', 'POST' ],
				endpoints: [
					{
						methods: [ 'GET' ],
						args: {
							context: {
								type: 'string',
								enum: [ 'view', 'edit', 'embed' ],
								default: 'view',
								required: false,
							},
							per_page: {
								type: 'integer',
								default: 10,
								required: false,
								description: 'Items per page.',
							},
						},
					},
					{
						methods: [ 'POST' ],
						args: {
							title: {
								type: 'string',
								required: true,
								description: 'The widget title.',
							},
							content: {
								type: 'string',
								description: 'The widget content.',
							},
							meta: {
								type: 'object',
								description: 'Meta fields.',
								properties: {
									color: {
										type: 'string',
										description: 'Accent color.',
									},
									tags: {
										type: 'array',
										description: 'Multi-value tag list.',
									},
								},
							},
						},
					},
				],
			} );
			return;
		}

		if ( path === '/wp-json/wp/v2/widgets' && req.method === 'GET' ) {
			// Honor `per_page` like WordPress: the body is one page, while
			// X-WP-Total still reports the whole collection.
			const perPage = Number( url.searchParams.get( 'per_page' ) );
			const all = [ ...widgets.values() ];
			send( res, 200, perPage > 0 ? all.slice( 0, perPage ) : all, {
				'X-WP-Total': String( widgets.size ),
				// Always claim a second page so the pagination hint is testable.
				'X-WP-TotalPages': String( Math.max( 2, widgets.size ) ),
			} );
			return;
		}

		if ( path === '/wp-json/wp/v2/widgets' && req.method === 'POST' ) {
			const body = await readBody( req );
			const id = nextId++;
			const meta =
				body.meta && typeof body.meta === 'object' ? body.meta : {};
			const record = {
				id,
				title: { rendered: String( body.title ?? '' ) },
				content: { rendered: String( body.content ?? '' ) },
				meta,
			};
			widgets.set( id, record );
			// Real WP's create_item returns 201 + a Location header. The
			// `posted` marker is only in the POST body (never stored), so
			// tests can tell it apart from the follow-up GET's response.
			const title = String( body.title ?? '' );
			const widgetsUrl = `${ baseUrlHolder.value }/wp-json/wp/v2/widgets`;
			const overrides: Record< string, string | undefined > = {
				'no-location': undefined,
				'foreign-location': `http://example.invalid/wp-json/wp/v2/widgets/${ id }`,
				'bad-location': `${ widgetsUrl }/999999`,
			};
			const location = Object.hasOwn( overrides, title )
				? overrides[ title ]
				: `${ widgetsUrl }/${ id }`;
			res.writeHead( 201, {
				'content-type': 'application/json',
				...( location ? { location } : {} ),
			} );
			res.end( JSON.stringify( { ...record, posted: true } ) );
			return;
		}

		const singularMatch = path.match(
			/^\/wp-json\/wp\/v2\/widgets\/(\d+)$/
		);
		if ( singularMatch ) {
			const id = Number( singularMatch[ 1 ] );
			if ( req.method === 'GET' ) {
				const record = widgets.get( id );
				if ( ! record ) {
					send( res, 404, {
						code: 'rest_widget_invalid_id',
						message: 'Invalid widget ID.',
						data: { status: 404 },
					} );
					return;
				}
				send( res, 200, record );
				return;
			}
			if ( req.method === 'PUT' ) {
				const existing = widgets.get( id );
				if ( ! existing ) {
					send( res, 404, {
						code: 'rest_widget_invalid_id',
						message: 'Invalid widget ID.',
						data: { status: 404 },
					} );
					return;
				}
				const body = await readBody( req );
				const meta = {
					...( ( existing.meta as Record< string, unknown > ) ?? {} ),
				};
				if ( body.meta && typeof body.meta === 'object' ) {
					for ( const [ key, value ] of Object.entries(
						body.meta as Record< string, unknown >
					) ) {
						if ( value === null ) {
							delete meta[ key ];
						} else {
							meta[ key ] = value;
						}
					}
				}
				const updated = {
					...existing,
					title:
						body.title !== undefined
							? { rendered: String( body.title ) }
							: existing.title,
					content:
						body.content !== undefined
							? { rendered: String( body.content ) }
							: existing.content,
					meta,
				};
				widgets.set( id, updated );
				send( res, 200, updated );
				return;
			}
			if ( req.method === 'DELETE' ) {
				const existing = widgets.get( id );
				widgets.delete( id );
				send( res, 200, { deleted: true, previous: existing } );
				return;
			}
		}

		if (
			path === '/wp-json/wp/v2/subscribers' &&
			req.method === 'OPTIONS'
		) {
			send( res, 200, {
				namespace: 'wp/v2',
				methods: [ 'GET', 'POST' ],
				endpoints: [
					{
						methods: [ 'GET' ],
						args: {
							context: {
								type: 'string',
								enum: [ 'view', 'edit', 'embed' ],
								default: 'view',
								required: false,
							},
						},
					},
					{
						methods: [ 'POST' ],
						args: {
							email: {
								type: 'string',
								format: 'email',
								required: true,
								description: "The subscriber's email address.",
							},
							age: {
								type: 'integer',
								required: true,
								description: "The subscriber's age.",
							},
							name: {
								type: 'string',
								required: false,
								description: "The subscriber's display name.",
							},
						},
					},
				],
			} );
			return;
		}

		if ( path === '/wp-json/wp/v2/subscribers' && req.method === 'GET' ) {
			send( res, 200, [ ...subscribers.values() ] );
			return;
		}

		if ( path === '/wp-json/wp/v2/subscribers' && req.method === 'POST' ) {
			const body = await readBody( req );
			const id = nextSubscriberId++;
			const record = {
				id,
				email: String( body.email ?? '' ),
				age: Number( body.age ),
				name: String( body.name ?? '' ),
			};
			subscribers.set( id, record );
			send( res, 201, record );
			return;
		}

		if ( path === '/wp-json/wp/v2/articles' && req.method === 'OPTIONS' ) {
			send( res, 200, {
				namespace: 'wp/v2',
				methods: [ 'GET', 'POST' ],
				endpoints: [
					{
						methods: [ 'GET' ],
						args: {
							context: {
								type: 'string',
								enum: [ 'view', 'edit', 'embed' ],
								default: 'view',
								required: false,
							},
						},
					},
					{
						methods: [ 'POST' ],
						args: {
							// Modelled on the real title/content/excerpt
							// schema WP_REST_Posts_Controller registers: an
							// `object` (not `string`) type, for the
							// `{raw, rendered}` shape — the controller
							// itself still accepts a plain string in place
							// of the full object (see `extractRawText`
							// below), which `generate`'s smart-default
							// synthesis must account for rather than
							// synthesizing an empty `{}` object.
							title: {
								type: 'object',
								required: false,
								description: 'The title for the article.',
								properties: {
									raw: { type: 'string' },
									rendered: {
										type: 'string',
										readonly: true,
									},
								},
							},
							content: {
								type: 'object',
								required: false,
								description: 'The content for the article.',
								properties: {
									raw: { type: 'string' },
									rendered: {
										type: 'string',
										readonly: true,
									},
								},
							},
							excerpt: {
								type: 'object',
								required: false,
								description: 'The excerpt for the article.',
								properties: {
									raw: { type: 'string' },
									rendered: {
										type: 'string',
										readonly: true,
									},
								},
							},
						},
					},
				],
			} );
			return;
		}

		if ( path === '/wp-json/wp/v2/articles' && req.method === 'GET' ) {
			send( res, 200, [ ...articles.values() ] );
			return;
		}

		if ( path === '/wp-json/wp/v2/articles' && req.method === 'POST' ) {
			const body = await readBody( req );
			const title = extractRawText( body.title );
			const content = extractRawText( body.content );
			const excerpt = extractRawText( body.excerpt );
			if ( ! title && ! content && ! excerpt ) {
				send( res, 400, {
					code: 'empty_content',
					message: 'Content, title, and excerpt are empty.',
					data: { status: 400 },
				} );
				return;
			}
			const id = nextArticleId++;
			const record = {
				id,
				title: { rendered: title },
				content: { rendered: content },
				excerpt: { rendered: excerpt },
			};
			articles.set( id, record );
			send( res, 201, record );
			return;
		}

		if ( path === '/wp-json/wp/v2/members' && req.method === 'OPTIONS' ) {
			send( res, 200, {
				namespace: 'wp/v2',
				methods: [ 'GET', 'POST' ],
				endpoints: [
					{ methods: [ 'GET' ], args: {} },
					{
						methods: [ 'POST' ],
						args: {
							username: {
								type: 'string',
								required: true,
								description: 'Login name for the member.',
							},
							email: {
								type: 'string',
								format: 'email',
								required: true,
								description: "The member's email address.",
							},
							password: {
								type: 'string',
								required: true,
								description: 'Password for the member.',
							},
							slug: {
								type: 'string',
								required: false,
								description:
									'An alphanumeric identifier for the member.',
							},
						},
					},
				],
			} );
			return;
		}

		if ( path === '/wp-json/wp/v2/members' && req.method === 'GET' ) {
			send( res, 200, [ ...members.values() ] );
			return;
		}

		if ( path === '/wp-json/wp/v2/members' && req.method === 'POST' ) {
			const body = await readBody( req );
			const username = String( body.username ?? '' );
			// Models a real-world constraint some sites enforce beyond
			// WordPress core's own (looser) validate_username() — lowercase,
			// no spaces — that a generic "Generated username 1" placeholder
			// fails but the identifier-field synthesis (generated-user-N)
			// satisfies.
			if ( ! /^[a-z0-9_.-]+$/.test( username ) ) {
				send( res, 400, {
					code: 'rest_invalid_param',
					message: 'Invalid parameter(s): username',
					data: {
						status: 400,
						params: { username: 'Invalid username.' },
					},
				} );
				return;
			}
			const id = nextMemberId++;
			const record = {
				id,
				username,
				email: String( body.email ?? '' ),
				slug: String( body.slug ?? '' ),
			};
			members.set( id, record );
			send( res, 201, record );
			return;
		}

		if ( path === '/wp-json/wp/v2/remarks' && req.method === 'OPTIONS' ) {
			send( res, 200, {
				namespace: 'wp/v2',
				methods: [ 'GET', 'POST' ],
				endpoints: [
					{ methods: [ 'GET' ], args: {} },
					{
						methods: [ 'POST' ],
						args: {
							content: {
								type: 'object',
								required: false,
								description: 'The content for the remark.',
								properties: {
									raw: { type: 'string' },
									rendered: {
										type: 'string',
										readonly: true,
									},
								},
							},
							post: {
								type: 'integer',
								default: 0,
								required: false,
								description:
									'The ID of the associated post object.',
							},
						},
					},
				],
			} );
			return;
		}

		if ( path === '/wp-json/wp/v2/remarks' && req.method === 'GET' ) {
			send( res, 200, [ ...remarks.values() ] );
			return;
		}

		if ( path === '/wp-json/wp/v2/remarks' && req.method === 'POST' ) {
			const body = await readBody( req );
			const content = extractRawText( body.content );
			if ( ! content ) {
				send( res, 400, {
					code: 'rest_comment_content_invalid',
					message: 'Invalid comment content.',
					data: { status: 400 },
				} );
				return;
			}
			const id = nextRemarkId++;
			const record = {
				id,
				content: { rendered: content },
				post: Number( body.post ?? 0 ),
			};
			remarks.set( id, record );
			send( res, 201, record );
			return;
		}

		if ( path === '/wp-json/wp/v2/gadgets' && req.method === 'OPTIONS' ) {
			send( res, 200, {
				namespace: 'wp/v2',
				methods: [ 'GET', 'POST' ],
				endpoints: [
					{ methods: [ 'GET' ], args: {} },
					{
						methods: [ 'POST' ],
						args: {
							id_base: {
								type: 'string',
								required: false,
								description: 'The type of the gadget.',
							},
							sidebar: {
								type: 'string',
								default: 'wp_inactive_widgets',
								required: true,
								description:
									'The sidebar to which the gadget belongs.',
							},
						},
					},
				],
			} );
			return;
		}

		if ( path === '/wp-json/wp/v2/gadgets' && req.method === 'GET' ) {
			send( res, 200, [ ...gadgets.values() ] );
			return;
		}

		if ( path === '/wp-json/wp/v2/gadgets' && req.method === 'POST' ) {
			const body = await readBody( req );
			const idBase = typeof body.id_base === 'string' ? body.id_base : '';
			if ( ! idBase ) {
				send( res, 400, {
					code: 'rest_invalid_widget',
					message: 'Widget type (id_base) is required.',
					data: { status: 400 },
				} );
				return;
			}
			const id = nextGadgetId++;
			const record = {
				id,
				id_base: idBase,
				sidebar: String( body.sidebar ?? '' ),
			};
			gadgets.set( id, record );
			send( res, 201, record );
			return;
		}

		if (
			path === '/wp-json/wp/v2/widget-types' &&
			req.method === 'OPTIONS'
		) {
			send( res, 200, {
				namespace: 'wp/v2',
				methods: [ 'GET' ],
				endpoints: [ { methods: [ 'GET' ] } ],
			} );
			return;
		}

		if (
			path === '/wp-json/wp/v2/taxonomies' &&
			req.method === 'OPTIONS'
		) {
			send( res, 200, {
				namespace: 'wp/v2',
				methods: [ 'GET' ],
				endpoints: [ { methods: [ 'GET' ] } ],
			} );
			return;
		}

		// Slug-keyed object, like real WordPress; `_fields` filters the slugs
		// themselves away, so a forwarded `_fields` yields `{}`.
		if ( path === '/wp-json/wp/v2/taxonomies' && req.method === 'GET' ) {
			send(
				res,
				200,
				url.searchParams.has( '_fields' )
					? {}
					: {
							category: { name: 'Categories', slug: 'category' },
							post_tag: { name: 'Tags', slug: 'post_tag' },
					  }
			);
			return;
		}

		if ( path === '/wp-json/wp/v2/widget-types' && req.method === 'GET' ) {
			send( res, 200, WIDGET_TYPES );
			return;
		}

		if ( path === '/wp-json/wp/v2/file-size' && req.method === 'OPTIONS' ) {
			send( res, 200, {
				namespace: 'wp/v2',
				methods: [ 'GET' ],
				endpoints: [
					{
						methods: [ 'GET' ],
						args: {
							url: {
								type: 'string',
								description: 'The URL of the file to check.',
								required: true,
							},
						},
					},
				],
			} );
			return;
		}

		if ( path === '/wp-json/wp/v2/file-size' && req.method === 'GET' ) {
			const fileUrl = url.searchParams.get( 'url' );
			if ( ! fileUrl ) {
				send( res, 400, {
					code: 'rest_missing_callback_param',
					message: 'Missing parameter(s): url',
					data: { status: 400, params: [ 'url' ] },
				} );
				return;
			}
			send( res, 200, { url: fileUrl, size: 12345 } );
			return;
		}

		if ( path === '/wp-json/wp/v2/settings' && req.method === 'OPTIONS' ) {
			send( res, 200, {
				namespace: 'wp/v2',
				methods: [ 'GET', 'POST', 'PUT', 'PATCH' ],
				endpoints: [
					{
						methods: [ 'GET', 'POST', 'PUT', 'PATCH' ],
						args: {
							title: {
								type: 'string',
								description: 'Site title.',
							},
						},
					},
				],
			} );
			return;
		}

		if ( path === '/wp-json/wp/v2/settings' && req.method === 'GET' ) {
			send( res, 200, settings );
			return;
		}

		if (
			path === '/wp-json/wp/v2/settings' &&
			( req.method === 'POST' || req.method === 'PUT' )
		) {
			const body = await readBody( req );
			if ( body.title !== undefined ) {
				settings.title = String( body.title );
			}
			send( res, 200, settings );
			return;
		}

		const themeStylesMatch = path.match(
			/^\/wp-json\/wp\/v2\/global-styles\/themes\/([^/]+)$/
		);
		if ( themeStylesMatch && req.method === 'GET' ) {
			const stylesheet = decodeURIComponent(
				themeStylesMatch[ 1 ] as string
			);
			if ( stylesheet !== 'twentytwentyfour' ) {
				send( res, 404, {
					code: 'rest_theme_not_found',
					message: 'Theme not found.',
					data: { status: 404 },
				} );
				return;
			}
			send( res, 200, { settings: {}, styles: {} } );
			return;
		}

		const gizmoMatch = path.match(
			/^\/wp-json\/wp\/v2\/gizmos\/parts\/electronic\/([^/]+)$/
		);
		if ( gizmoMatch && req.method === 'GET' ) {
			send( res, 200, { id: gizmoMatch[ 1 ], kind: 'electronic' } );
			return;
		}

		const singleRevisionMatch = path.match(
			/^\/wp-json\/wp\/v2\/posts\/([^/]+)\/revisions\/([^/]+)$/
		);
		if ( singleRevisionMatch && req.method === 'GET' ) {
			const parent = singleRevisionMatch[ 1 ] as string;
			const id = singleRevisionMatch[ 2 ] as string;
			if ( parent !== '10' || id !== '101' ) {
				send( res, 404, {
					code: 'rest_post_invalid_id',
					message: 'Invalid post parent or revision ID.',
					data: { status: 404 },
				} );
				return;
			}
			send( res, 200, { id: 101, parent: 10 } );
			return;
		}

		const revisionsMatch = path.match(
			/^\/wp-json\/wp\/v2\/posts\/([^/]+)\/revisions$/
		);
		if ( revisionsMatch && req.method === 'GET' ) {
			const parent = revisionsMatch[ 1 ] as string;
			if ( parent !== '10' ) {
				send( res, 404, {
					code: 'rest_post_invalid_id',
					message: 'Invalid post parent ID.',
					data: { status: 404 },
				} );
				return;
			}
			send( res, 200, [ { id: 101, parent: 10 } ] );
			return;
		}

		const variationsMatch = path.match(
			/^\/wp-json\/wp\/v2\/global-styles\/themes\/([^/]+)\/variations$/
		);
		if ( variationsMatch && req.method === 'GET' ) {
			const stylesheet = decodeURIComponent(
				variationsMatch[ 1 ] as string
			);
			if ( stylesheet !== 'twentytwentyfour' ) {
				send( res, 404, {
					code: 'rest_theme_not_found',
					message: 'Theme not found.',
					data: { status: 404 },
				} );
				return;
			}
			send( res, 200, [ { title: 'Default', settings: {} } ] );
			return;
		}

		// The three routes below (introspect, /users/me, DELETE .../{uuid})
		// share a small set of reserved sentinel values that select specific
		// fixture behavior — collected here so a future test author doesn't
		// reuse one of these for an unrelated purpose and get a confusing,
		// silent behavior change:
		//   - username 'admin'         → introspect 404s, i.e. "this is a real
		//                                 account password, not an app password."
		//   - password 'wrong-password' → /users/me 401s, i.e. "credentials
		//                                 rejected" (any other password succeeds).
		//   - uuid 'uuid-unrevokable'    → DELETE always 404s, i.e. "could not
		//                                 revoke remotely" (any other uuid is
		//                                 accepted and tracked as revoked).
		//
		// Models WordPress's real endpoint, which returns details of whichever
		// Application Password is authenticating the current request — used by
		// `wp auth application-passwords login`/`wp auth application-passwords
		// remove` to capture a credential's uuid.
		if (
			path ===
				'/wp-json/wp/v2/users/me/application-passwords/introspect' &&
			req.method === 'GET'
		) {
			const auth = parseBasicAuth( req );
			if ( ! auth ) {
				send( res, 401, {
					code: 'rest_not_logged_in',
					message: 'You are not currently logged in.',
					data: { status: 401 },
				} );
				return;
			}
			// 'admin' is reserved to model "authenticated fine via a real
			// account password, not an application password."
			if ( auth.username === 'admin' ) {
				send( res, 404, {
					code: 'rest_no_application_password',
					message:
						'Could not find an application password for the given user.',
					data: { status: 404 },
				} );
				return;
			}
			send( res, 200, {
				uuid: `uuid-${ auth.username }`,
				app_id: null,
				name: 'wp-rest-cli',
				created: 1700000000,
				last_used: null,
				last_ip: null,
			} );
			return;
		}

		// Models the generic "am I authenticated at all" check
		// `wp auth application-passwords add`'s validation falls back to when
		// introspection above doesn't apply. Also accepts a Bearer token
		// issued by the OAuth2 token endpoint above, for `wp auth oauth2
		// add`'s own best-effort verification step — authenticating as user
		// id 0, modelling a client_credentials token's lack of real user
		// context. A recognized personal token (see `KNOWN_PERSONAL_TOKEN`)
		// authenticates as a real user instead, so `wp auth oauth2 add
		// --token=`'s verification step can tell the two apart.
		if ( path === '/wp-json/wp/v2/users/me' && req.method === 'GET' ) {
			const authHeader = req.headers.authorization;
			if ( authHeader?.startsWith( 'Bearer ' ) ) {
				const token = authHeader.slice( 'Bearer '.length );
				if ( token === KNOWN_PERSONAL_TOKEN ) {
					send( res, 200, { id: 1, name: 'test-user' } );
					return;
				}
				if ( oauth2AccessTokens.has( token ) ) {
					send( res, 200, { id: 0, name: 'oauth2-client' } );
					return;
				}
				send( res, 401, {
					code: 'rest_not_logged_in',
					message: 'You are not currently logged in.',
					data: { status: 401 },
				} );
				return;
			}
			const auth = parseBasicAuth( req );
			if ( ! auth ) {
				send( res, 401, {
					code: 'rest_not_logged_in',
					message: 'You are not currently logged in.',
					data: { status: 401 },
				} );
				return;
			}
			// 'wrong-password' is a reserved sentinel for deliberately
			// exercising the "credentials rejected" path.
			if ( auth.password === 'wrong-password' ) {
				send( res, 401, {
					code: 'rest_forbidden',
					message: 'Invalid username or password.',
					data: { status: 401 },
				} );
				return;
			}
			send( res, 200, { id: 1, name: auth.username } );
			return;
		}

		const applicationPasswordMatch = path.match(
			/^\/wp-json\/wp\/v2\/users\/me\/application-passwords\/([^/]+)$/
		);
		if ( applicationPasswordMatch && req.method === 'DELETE' ) {
			const uuid = decodeURIComponent(
				applicationPasswordMatch[ 1 ] as string
			);
			// Reserved to always 404, modelling "could not revoke remotely,
			// fell back to local-only removal" — never actually revoked.
			if ( uuid === 'uuid-unrevokable' ) {
				send( res, 404, {
					code: 'rest_application_password_not_found',
					message: 'Application password not found.',
					data: { status: 404 },
				} );
				return;
			}
			const auth = parseBasicAuth( req );
			if ( ! auth ) {
				send( res, 401, {
					code: 'rest_not_logged_in',
					message: 'You are not currently logged in.',
					data: { status: 401 },
				} );
				return;
			}
			revokedUuids.add( uuid );
			send( res, 200, { deleted: true, previous: { uuid } } );
			return;
		}

		send( res, 404, {
			code: 'rest_no_route',
			message: 'No route was found matching the URL and request method.',
			data: { status: 404 },
		} );
	} );

	await new Promise< void >( ( resolve ) =>
		server.listen( 0, '127.0.0.1', resolve )
	);
	const address = server.address();
	const port = typeof address === 'object' && address ? address.port : 0;
	const baseUrl = `http://127.0.0.1:${ port }`;
	baseUrlHolder.value = baseUrl;

	return {
		server,
		baseUrl,
		close: () =>
			new Promise< void >( ( resolve ) =>
				server.close( () => resolve() )
			),
	};
}

// The HEAD handler needs to know the fixture's own base URL to build the Link
// header before startFixture() has returned it; this small mutable holder
// breaks that ordering dependency without restructuring the request handler.
const baseUrlHolder = { value: '' };
