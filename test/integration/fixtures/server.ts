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

function send( res: ServerResponse, status: number, body?: unknown ): void {
	res.writeHead( status, { 'content-type': 'application/json' } );
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

export async function startFixture(): Promise< Fixture > {
	const server = createServer( async ( req, res ) => {
		const url = new URL( req.url ?? '/', 'http://localhost' );
		const path = url.pathname;

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
			send( res, 200, [ ...widgets.values() ] );
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
				meta,
			};
			widgets.set( id, record );
			send( res, 201, record );
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
		// introspection above doesn't apply.
		if ( path === '/wp-json/wp/v2/users/me' && req.method === 'GET' ) {
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
