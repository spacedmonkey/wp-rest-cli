/**
 * External dependencies
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Internal dependencies
 */
import { runCli } from './fixtures/run-cli.js';
import { startFixture, type Fixture } from './fixtures/server.js';

let fixture: Fixture;

beforeAll( async () => {
	fixture = await startFixture();
} );

afterAll( async () => {
	await fixture.close();
} );

function run( args: string[] ) {
	return runCli( [
		...args,
		`--url=${ fixture.baseUrl }`,
		'--quiet',
		'--no-color',
	] );
}

describe( 'route navigation (arbitrary-depth nested routes)', () => {
	it( "lists a deeply-nested route's first segment at the namespace root, marked as a subcommand", async () => {
		const result = await run( [ 'wp/v2', '--format=json' ] );
		expect( result.exitCode ).toBe( 0 );
		const rows = JSON.parse( result.stdout ) as Array< {
			route: string;
			verbs: string;
		} >;
		const gizmos = rows.find( ( r ) => r.route === 'gizmos' );
		expect( gizmos?.verbs ).toContain( '(subcommand)' );
		expect( rows.some( ( r ) => r.route === 'gizmos/parts' ) ).toBe(
			false
		);
	} );

	it( 'lists the next segment when drilling into a container prefix', async () => {
		const result = await run( [ 'wp/v2', 'gizmos', '--format=json' ] );
		expect( result.exitCode ).toBe( 0 );
		const rows = JSON.parse( result.stdout ) as Array< {
			route: string;
			verbs: string;
		} >;
		expect( rows ).toEqual( [ { route: 'parts', verbs: '(subcommand)' } ] );
	} );

	it( 'keeps drilling in another level deeper, reaching the parameterised leaf itself', async () => {
		const result = await run( [
			'wp/v2',
			'gizmos',
			'parts',
			'--format=json',
		] );
		expect( result.exitCode ).toBe( 0 );
		const rows = JSON.parse( result.stdout ) as Array< {
			route: string;
			verbs: string;
		} >;
		// "electronic" is the leaf route itself here (parameterised-only,
		// like global-styles/themes), not a further container, so it shows
		// its own real verbs rather than a "(subcommand)" marker.
		expect( rows ).toEqual( [
			{ route: 'electronic', verbs: 'get, exists' },
		] );
	} );

	it( 'shows the param-required note once the full nested route is typed', async () => {
		const result = await run( [
			'wp/v2',
			'gizmos',
			'parts',
			'electronic',
		] );
		expect( result.exitCode ).toBe( 0 );
		expect( result.stdout ).toContain(
			'This route only exists with a value in place of its URL parameter'
		);
	} );

	it( 'performs a get against a route nested three nested segments deep', async () => {
		const result = await run( [
			'wp/v2',
			'gizmos',
			'parts',
			'electronic',
			'get',
			'7',
			'--format=json',
		] );
		expect( result.exitCode ).toBe( 0 );
		expect( JSON.parse( result.stdout ) ).toEqual( {
			id: '7',
			kind: 'electronic',
		} );
	} );
} );

describe( 'routes with a mid-path URL parameter (not at the end)', () => {
	it( 'lists a route whose parameter sits in the middle of the path, joined by its literal segments', async () => {
		const result = await run( [ 'wp/v2', 'posts', '--format=json' ] );
		expect( result.exitCode ).toBe( 0 );
		const rows = JSON.parse( result.stdout ) as Array< {
			route: string;
			verbs: string;
		} >;
		expect( rows ).toEqual( [
			{ route: 'revisions', verbs: 'list, get, exists' },
		] );
	} );

	it( 'shows the param-required note for a mid-path route with no value given', async () => {
		const result = await run( [ 'wp/v2', 'posts', 'revisions' ] );
		expect( result.exitCode ).toBe( 0 );
		expect( result.stdout ).toContain(
			'This route only exists with a value in place of its URL parameter'
		);
	} );

	it( 'splices the value into the middle of the URL for `get`, not the end', async () => {
		const result = await run( [
			'wp/v2',
			'posts',
			'revisions',
			'get',
			'10',
			'--format=json',
		] );
		expect( result.exitCode ).toBe( 0 );
		expect( JSON.parse( result.stdout ) ).toEqual( [
			{ id: 101, parent: 10 },
		] );
	} );

	it( '404s naturally for a parent id the fixture does not recognise', async () => {
		const result = await run( [
			'wp/v2',
			'posts',
			'revisions',
			'get',
			'999',
		] );
		expect( result.exitCode ).toBe( 1 );
	} );

	it( 'marks a route as both directly addressable and a subcommand when it has a mid-path-parameter child', async () => {
		const result = await run( [
			'wp/v2',
			'global-styles',
			'--format=json',
		] );
		expect( result.exitCode ).toBe( 0 );
		const rows = JSON.parse( result.stdout ) as Array< {
			route: string;
			verbs: string;
		} >;
		expect( rows ).toEqual( [
			{ route: 'themes', verbs: 'get, exists, (subcommand)' },
		] );
	} );

	it( 'still performs a get against the hybrid route itself (unaffected by its new child)', async () => {
		const result = await run( [
			'wp/v2',
			'global-styles',
			'themes',
			'get',
			'twentytwentyfour',
			'--format=json',
		] );
		expect( result.exitCode ).toBe( 0 );
		expect( JSON.parse( result.stdout ) ).toEqual( {
			settings: {},
			styles: {},
		} );
	} );

	it( 'performs a get against the child nested beneath the hybrid route', async () => {
		const result = await run( [
			'wp/v2',
			'global-styles',
			'themes',
			'variations',
			'get',
			'twentytwentyfour',
			'--format=json',
		] );
		expect( result.exitCode ).toBe( 0 );
		expect( JSON.parse( result.stdout ) ).toEqual( [
			{ title: 'Default', settings: {} },
		] );
	} );
} );

describe( 'routes with two URL parameters', () => {
	it( 'performs a get, with no verb needed, when exactly enough trailing values are given', async () => {
		const result = await run( [
			'wp/v2',
			'posts',
			'revisions',
			'10',
			'101',
			'--format=json',
		] );
		expect( result.exitCode ).toBe( 0 );
		expect( JSON.parse( result.stdout ) ).toEqual( {
			id: 101,
			parent: 10,
		} );
	} );

	it( '404s naturally for a value combination the fixture does not recognise', async () => {
		const result = await run( [
			'wp/v2',
			'posts',
			'revisions',
			'10',
			'999',
		] );
		expect( result.exitCode ).toBe( 1 );
	} );

	it( 'does not misfire with only one trailing value (needs exactly two)', async () => {
		// Only one trailing value doesn't match the two-parameter route at
		// all (it needs exactly two), and — with no verb — isn't the
		// single-parameter "revisions get <value>" form either, so this
		// falls all the way through to a live 404, same as any other
		// unrecognised bare route.
		const result = await run( [ 'wp/v2', 'posts', 'revisions', '10' ] );
		expect( result.exitCode ).toBe( 1 );
	} );
} );

describe( 'singleton routes (e.g. settings)', () => {
	it( 'does not offer get/update/delete/exists <id> for a route with no addressable id', async () => {
		const result = await run( [ 'wp/v2', 'settings' ] );
		expect( result.exitCode ).toBe( 0 );
		expect( result.stdout ).toContain(
			'usage: wp-rest-cli wp/v2 settings list'
		);
		expect( result.stdout ).not.toContain( 'settings get <id>' );
		expect( result.stdout ).not.toContain( 'settings update <id>' );
		expect( result.stdout ).not.toContain( 'settings delete <id>' );
		expect( result.stdout ).not.toContain( 'settings exists <id>' );
		expect( result.stdout ).toContain(
			'This route has no addressable <id>'
		);
	} );

	it( 'warns in `help <namespace> <route> get` that the route has no id', async () => {
		const result = await run( [ 'help', 'wp/v2', 'settings', 'get' ] );
		expect( result.exitCode ).toBe( 0 );
		expect( result.stdout ).toContain( 'Warning' );
		expect( result.stdout ).toContain( 'doesn\'t appear to support "get"' );
	} );

	it( 'reads and writes the singleton via list/create, not get/update', async () => {
		const before = await run( [
			'wp/v2',
			'settings',
			'list',
			'--format=json',
		] );
		expect( before.exitCode ).toBe( 0 );
		expect( JSON.parse( before.stdout ) ).toEqual( {
			title: 'Fixture Site',
		} );

		const updated = await run( [
			'wp/v2',
			'settings',
			'create',
			'--title=Updated Site',
			'--format=json',
		] );
		expect( updated.exitCode ).toBe( 0 );
		expect( JSON.parse( updated.stdout ) ).toEqual( {
			title: 'Updated Site',
		} );
	} );
} );

describe( 'exists', () => {
	it( 'exits 0 and reports success for an id that exists', async () => {
		const created = await run( [
			'wp/v2',
			'widgets',
			'create',
			'--title=Exists target',
			'--format=json',
		] );
		const id = JSON.parse( created.stdout ).id;

		const result = await run( [
			'wp/v2',
			'widgets',
			'exists',
			String( id ),
		] );
		expect( result.exitCode ).toBe( 0 );
		expect( result.stdout ).toContain( 'exists' );
	} );

	it( 'exits 1 without an Error: line for an id that does not exist', async () => {
		const result = await run( [ 'wp/v2', 'widgets', 'exists', '999999' ] );
		expect( result.exitCode ).toBe( 1 );
		expect( result.stdout ).toContain( 'does not exist' );
		expect( result.stderr ).toBe( '' );
	} );

	it( 'reports a structured boolean under --format=json', async () => {
		const result = await run( [
			'wp/v2',
			'widgets',
			'exists',
			'999999',
			'--format=json',
		] );
		expect( result.exitCode ).toBe( 1 );
		expect( JSON.parse( result.stdout ) ).toEqual( { exists: false } );
	} );
} );

describe( 'generate', () => {
	it( 'creates --count items reusing the same fields for each', async () => {
		const before = await run( [
			'wp/v2',
			'widgets',
			'list',
			'--format=count',
		] );
		const beforeCount = Number( before.stdout.trim() );

		const result = await run( [
			'wp/v2',
			'widgets',
			'generate',
			'--count=3',
			'--title=Bulk widget',
		] );
		expect( result.exitCode ).toBe( 0 );
		expect( result.stdout ).toContain( 'created 3' );

		const after = await run( [
			'wp/v2',
			'widgets',
			'list',
			'--format=json',
		] );
		const items = JSON.parse( after.stdout ) as Array< {
			title: { rendered: string };
		} >;
		expect( items.length ).toBe( beforeCount + 3 );
		expect(
			items.filter( ( w ) => w.title.rendered === 'Bulk widget' ).length
		).toBe( 3 );
	} );

	it( 'rejects a non-positive-integer --count', async () => {
		const result = await run( [
			'wp/v2',
			'widgets',
			'generate',
			'--count=0',
		] );
		expect( result.exitCode ).toBe( 1 );
		expect( result.stderr ).toContain(
			'--count must be a positive integer'
		);
	} );

	// Same as `run()`, but without `--quiet`, so the auto-fill notice
	// (suppressed by `--quiet`, like every other progress line) is
	// observable — `wp/v2 subscribers` (unlike `widgets`) has required
	// fields with an email `format` and an `integer` type, to exercise
	// smart-default synthesis.
	function runVerbose( args: string[] ) {
		return runCli( [
			...args,
			`--url=${ fixture.baseUrl }`,
			'--no-color',
		] );
	}

	it( 'auto-fills missing required fields with synthesized, unique-per-item values', async () => {
		const before = await run( [
			'wp/v2',
			'subscribers',
			'list',
			'--format=count',
		] );
		const beforeCount = Number( before.stdout.trim() );

		const result = await run( [
			'wp/v2',
			'subscribers',
			'generate',
			'--count=3',
		] );
		expect( result.exitCode ).toBe( 0 );

		const after = await run( [
			'wp/v2',
			'subscribers',
			'list',
			'--format=json',
		] );
		const items = JSON.parse( after.stdout ) as Array< {
			email: string;
			age: number;
		} >;
		const created = items.slice( beforeCount );
		expect( created.map( ( s ) => s.email ) ).toEqual( [
			'generated-1@example.com',
			'generated-2@example.com',
			'generated-3@example.com',
		] );
		expect( created.map( ( s ) => s.age ) ).toEqual( [ 1, 2, 3 ] );
	} );

	it( 'prints a notice naming auto-filled fields, unless --quiet is passed', async () => {
		const verbose = await runVerbose( [
			'wp/v2',
			'subscribers',
			'generate',
			'--count=1',
		] );
		expect( verbose.exitCode ).toBe( 0 );
		expect( verbose.stderr ).toContain(
			'Note: --email, --age not supplied; using generated values.'
		);

		const quiet = await run( [
			'wp/v2',
			'subscribers',
			'generate',
			'--count=1',
		] );
		expect( quiet.exitCode ).toBe( 0 );
		expect( quiet.stderr ).not.toContain( 'Note:' );
	} );

	it( 'keeps a user-supplied value for a required field instead of generating one', async () => {
		const result = await run( [
			'wp/v2',
			'subscribers',
			'generate',
			'--count=2',
			'--email=fixed@example.com',
		] );
		expect( result.exitCode ).toBe( 0 );

		const after = await run( [
			'wp/v2',
			'subscribers',
			'list',
			'--format=json',
		] );
		const items = JSON.parse( after.stdout ) as Array< {
			email: string;
			age: number;
		} >;
		const created = items.slice( -2 );
		expect(
			created.every( ( s ) => s.email === 'fixed@example.com' )
		).toBe( true );
		expect( created.map( ( s ) => s.age ) ).toEqual( [ 1, 2 ] );
	} );

	it( 'retries once on a live "empty_content" rejection (WP core posts/pages), synthesizing every empty-content field (not just one), reused for the rest of the batch, printing the fallback notice exactly once', async () => {
		const before = await run( [
			'wp/v2',
			'articles',
			'list',
			'--format=count',
		] );
		const beforeCount = Number( before.stdout.trim() );

		const verbose = await runVerbose( [
			'wp/v2',
			'articles',
			'generate',
			'--count=3',
		] );
		expect( verbose.exitCode ).toBe( 0 );
		const noticeOccurrences = (
			verbose.stderr.match(
				/Note: the API rejected an empty item; also generating --title, --content, --excerpt\./g
			) ?? []
		).length;
		expect( noticeOccurrences ).toBe( 1 );

		const after = await run( [
			'wp/v2',
			'articles',
			'list',
			'--format=json',
		] );
		const items = JSON.parse( after.stdout ) as Array< {
			title: { rendered: string };
			content: { rendered: string };
			excerpt: { rendered: string };
		} >;
		const created = items.slice( beforeCount );
		expect( created.map( ( a ) => a.title.rendered ) ).toEqual( [
			'Generated title 1',
			'Generated title 2',
			'Generated title 3',
		] );
		expect( created.map( ( a ) => a.content.rendered ) ).toEqual( [
			'Generated content 1',
			'Generated content 2',
			'Generated content 3',
		] );
		expect( created.map( ( a ) => a.excerpt.rendered ) ).toEqual( [
			'Generated excerpt 1',
			'Generated excerpt 2',
			'Generated excerpt 3',
		] );
	} );

	it( 'never retries when a user-supplied field already satisfies the API', async () => {
		const before = await run( [
			'wp/v2',
			'articles',
			'list',
			'--format=count',
		] );
		const beforeCount = Number( before.stdout.trim() );

		const result = await run( [
			'wp/v2',
			'articles',
			'generate',
			'--count=2',
			'--content=Hand-written content',
		] );
		expect( result.exitCode ).toBe( 0 );

		const after = await run( [
			'wp/v2',
			'articles',
			'list',
			'--format=json',
		] );
		const items = JSON.parse( after.stdout ) as Array< {
			title: { rendered: string };
			content: { rendered: string };
		} >;
		const created = items.slice( beforeCount );
		expect(
			created.every(
				( a ) => a.content.rendered === 'Hand-written content'
			)
		).toBe( true );
		expect( created.every( ( a ) => a.title.rendered === '' ) ).toBe(
			true
		);
	} );

	it( 'synthesizes a lowercase, hyphenated username (not a generic "Generated username N" placeholder)', async () => {
		// wp/v2/members' `username` schema, like real WordPress's own
		// wp/v2/users, gives no hint (no pattern/format) that it needs
		// to be login-safe — the fixture's POST handler enforces that
		// constraint itself and would 400 on the generic placeholder.
		const result = await run( [
			'wp/v2',
			'members',
			'generate',
			'--count=3',
		] );
		expect( result.exitCode ).toBe( 0 );

		const after = await run( [
			'wp/v2',
			'members',
			'list',
			'--format=json',
		] );
		const items = JSON.parse( after.stdout ) as Array< {
			username: string;
			email: string;
		} >;
		expect( items.map( ( m ) => m.username ) ).toEqual( [
			'generated-user-1',
			'generated-user-2',
			'generated-user-3',
		] );
		expect( items.map( ( m ) => m.email ) ).toEqual( [
			'generated-1@example.com',
			'generated-2@example.com',
			'generated-3@example.com',
		] );
	} );

	it( 'retries on a second known hidden-content error code ("rest_comment_content_invalid"), not just "empty_content"', async () => {
		// wp/v2/remarks' `content` is required: false in the schema
		// (like articles' title/content/excerpt), but unlike articles,
		// only `content` itself can satisfy the rejection — there's no
		// title/excerpt to substitute — proving
		// HIDDEN_REQUIRED_FIELDS_BY_ERROR_CODE (rest.ts) is a real
		// per-code lookup, not hardcoded to the posts/pages case.
		const before = await run( [
			'wp/v2',
			'remarks',
			'list',
			'--format=count',
		] );
		const beforeCount = Number( before.stdout.trim() );

		const verbose = await runVerbose( [
			'wp/v2',
			'remarks',
			'generate',
			'--count=2',
		] );
		expect( verbose.exitCode ).toBe( 0 );
		const noticeOccurrences = (
			verbose.stderr.match(
				/Note: the API rejected an empty item; also generating --content\./g
			) ?? []
		).length;
		expect( noticeOccurrences ).toBe( 1 );

		const after = await run( [
			'wp/v2',
			'remarks',
			'list',
			'--format=json',
		] );
		const items = JSON.parse( after.stdout ) as Array< {
			content: { rendered: string };
		} >;
		const created = items.slice( beforeCount );
		expect( created.map( ( r ) => r.content.rendered ) ).toEqual( [
			'Generated content 1',
			'Generated content 2',
		] );
	} );

	it( 'discovers a real widget type for id_base via the sibling widget-types route, not a synthesized placeholder', async () => {
		// wp/v2/gadgets' `id_base` is required: false in the schema
		// (like real WordPress's own wp/v2/widgets), but POST still
		// rejects an item missing it — with no field that could ever
		// stand in for it, since a widget type has to really exist.
		// `sidebar` is required: true *with* a default, exercising the
		// default-wins-over-required-ness path (generateDefaultValue)
		// alongside the id_base discovery in the same run.
		const before = await run( [
			'wp/v2',
			'gadgets',
			'list',
			'--format=count',
		] );
		const beforeCount = Number( before.stdout.trim() );

		const verbose = await runVerbose( [
			'wp/v2',
			'gadgets',
			'generate',
			'--count=3',
		] );
		expect( verbose.exitCode ).toBe( 0 );
		expect( verbose.stderr ).toContain(
			'Note: --sidebar not supplied; using generated values.'
		);
		const noticeOccurrences = (
			verbose.stderr.match(
				/Note: --id_base not supplied; using the first available widget type \("search"\)\./g
			) ?? []
		).length;
		expect( noticeOccurrences ).toBe( 1 );

		const after = await run( [
			'wp/v2',
			'gadgets',
			'list',
			'--format=json',
		] );
		const items = JSON.parse( after.stdout ) as Array< {
			id_base: string;
			sidebar: string;
		} >;
		const created = items.slice( beforeCount );
		expect( created.every( ( g ) => g.id_base === 'search' ) ).toBe( true );
		expect(
			created.every( ( g ) => g.sidebar === 'wp_inactive_widgets' )
		).toBe( true );
	} );

	it( 'agent mode: no animated bar (no ANSI, no carriage returns) on stderr', async () => {
		const result = await runCli(
			[
				'wp/v2',
				'widgets',
				'generate',
				'--count=3',
				'--title=Bulk widget',
				`--url=${ fixture.baseUrl }`,
			],
			{ env: { WP_REST_CLI_AGENT: '1' } }
		);
		expect( result.exitCode ).toBe( 0 );
		expect( result.stderr ).not.toMatch( /\x1b\[|\r/ );
		expect( result.stderr ).toContain( 'Generating wp/v2/widgets' );
		expect( result.stderr ).toContain( 'done (3/3)' );
	} );
} );
