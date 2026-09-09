/**
 * External dependencies
 */
import { execa } from 'execa';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Internal dependencies
 */
import { startFixture, type Fixture } from './fixtures/server.js';

const cliEntry = fileURLToPath(
	new URL( '../../src/cli.ts', import.meta.url )
);

let fixture: Fixture;

beforeAll( async () => {
	fixture = await startFixture();
} );

afterAll( async () => {
	await fixture.close();
} );

function run( args: string[] ) {
	return execa(
		'tsx',
		[
			cliEntry,
			...args,
			`--url=${ fixture.baseUrl }`,
			'--quiet',
			'--no-color',
		],
		{
			reject: false,
			preferLocal: true,
		}
	);
}

describe( 'wp-rest-cli (integration)', () => {
	it( 'lists namespaces when run with no args, WP-CLI-native NAME/DESCRIPTION/SYNOPSIS/SUBCOMMANDS style', async () => {
		const result = await run( [] );
		expect( result.exitCode ).toBe( 0 );
		expect( result.stdout ).toContain( 'NAME' );
		expect( result.stdout ).toContain( 'wp-rest-cli' );
		expect( result.stdout ).toContain( 'DESCRIPTION' );
		expect( result.stdout ).toContain( 'SYNOPSIS' );
		expect( result.stdout ).toContain( 'wp-rest-cli <namespace>' );
		expect( result.stdout ).toContain( 'SUBCOMMANDS' );
		expect( result.stdout ).toContain( 'wp/v2' );
		expect( result.stdout ).toContain( 'Application Passwords' );
	} );

	it( 'still lists namespaces as plain rows for a non-table --format', async () => {
		const result = await run( [ '--format=json' ] );
		expect( result.exitCode ).toBe( 0 );
		expect( JSON.parse( result.stdout ) ).toEqual( [
			{ namespace: 'wp/v2' },
		] );
	} );

	it( 'lists routes for a namespace, with a verbs column instead of raw HTTP methods', async () => {
		const result = await run( [ 'wp/v2', '--format=json' ] );
		expect( result.exitCode ).toBe( 0 );
		const rows = JSON.parse( result.stdout ) as Array< {
			route: string;
			verbs: string;
		} >;
		const widgets = rows.find( ( r ) => r.route === 'widgets' );
		expect( widgets?.verbs ).toBe(
			'list, get, create, update, delete, exists, generate'
		);
	} );

	it( 'lists routes for a namespace in table format as a WP-CLI-native SUBCOMMANDS page', async () => {
		const result = await run( [ 'wp/v2' ] );
		expect( result.exitCode ).toBe( 0 );
		expect( result.stdout ).toContain( 'NAME' );
		expect( result.stdout ).toContain( 'wp-rest-cli wp/v2' );
		expect( result.stdout ).toContain( 'SYNOPSIS' );
		expect( result.stdout ).toContain( 'wp-rest-cli wp/v2 <route>' );
		expect( result.stdout ).toContain( 'SUBCOMMANDS' );
		expect( result.stdout ).toMatch(
			/widgets\s+list, get, create, update, delete, exists, generate/
		);
		// A pure container (no verbs of its own) shows only the marker.
		expect( result.stdout ).toMatch( /global-styles\s+\(subcommand\)/ );
	} );

	it( 'introspects a route via OPTIONS', async () => {
		const result = await run( [ 'wp/v2', 'widgets' ] );
		expect( result.exitCode ).toBe( 0 );
		expect( result.stdout ).toContain( 'per_page' );
		// A required arg is shown bare (no brackets), unlike an optional one.
		expect( result.stdout ).toContain( '--title=<string>' );
		expect( result.stdout ).not.toContain( '[--title=<string>]' );
	} );

	it( 'shows a WP-CLI-style usage synopsis covering every verb', async () => {
		const result = await run( [ 'wp/v2', 'widgets' ] );
		expect( result.exitCode ).toBe( 0 );
		const lines = result.stdout.split( '\n' );
		expect( lines[ 0 ] ).toBe(
			'usage: wp-rest-cli wp/v2 widgets list [--context=<context>] [--per_page=<per_page>]'
		);
		expect( lines[ 1 ] ).toBe(
			'   or: wp-rest-cli wp/v2 widgets get <id> [--context=<context>]'
		);
		expect( lines[ 2 ] ).toBe(
			'   or: wp-rest-cli wp/v2 widgets create --title=<title> [--meta=<meta>] [--<field>=<value>]'
		);
		expect( lines[ 3 ] ).toBe(
			'   or: wp-rest-cli wp/v2 widgets update <id> --title=<title> [--meta=<meta>] [--<field>=<value>]'
		);
		expect( lines[ 4 ] ).toBe(
			'   or: wp-rest-cli wp/v2 widgets delete <id> [--force]'
		);
		expect( lines[ 5 ] ).toBe(
			'   or: wp-rest-cli wp/v2 widgets exists <id>'
		);
		expect( lines[ 6 ] ).toBe(
			'   or: wp-rest-cli wp/v2 widgets generate [--count=<count>] --title=<title> [--meta=<meta>] [--<field>=<value>]'
		);
	} );

	it( 'lists items for a route', async () => {
		const result = await run( [
			'wp/v2',
			'widgets',
			'list',
			'--format=json',
		] );
		expect( result.exitCode ).toBe( 0 );
		const body = JSON.parse( result.stdout );
		expect( body ).toEqual( [
			{
				id: 1,
				title: { rendered: 'First widget' },
				link: '/widgets/1',
				meta: {},
			},
		] );
	} );

	it( 'gets a single item by id', async () => {
		const result = await run( [
			'wp/v2',
			'widgets',
			'get',
			'1',
			'--field=title.rendered',
		] );
		expect( result.exitCode ).toBe( 0 );
		expect( result.stdout.trim() ).toBe( 'First widget' );
	} );

	it( 'renders a friendly error for a 404', async () => {
		const result = await run( [ 'wp/v2', 'widgets', 'get', '999' ] );
		expect( result.exitCode ).toBe( 1 );
		expect( result.stderr ).toContain( 'Invalid widget ID.' );
		expect( result.stderr ).toContain( 'rest_widget_invalid_id' );
	} );

	it( 'creates an item from field=value args', async () => {
		const result = await run( [
			'wp/v2',
			'widgets',
			'create',
			'--title=New widget',
		] );
		expect( result.exitCode ).toBe( 0 );
		expect( result.stdout ).toContain( 'Success' );
	} );

	it( 'updates an item by id', async () => {
		const result = await run( [
			'wp/v2',
			'widgets',
			'update',
			'1',
			'--title=Renamed',
			'--format=json',
		] );
		expect( result.exitCode ).toBe( 0 );
		const body = JSON.parse( result.stdout );
		expect( body.title.rendered ).toBe( 'Renamed' );
	} );

	it( 'rejects a non-integer value for an integer-typed field before sending the request', async () => {
		const result = await run( [
			'wp/v2',
			'widgets',
			'list',
			'--per_page=abc',
		] );
		expect( result.exitCode ).toBe( 1 );
		expect( result.stderr ).toContain(
			'--per_page must be of type integer, got "abc".'
		);
	} );

	it( 'rejects create when a required field is missing, before sending the request', async () => {
		const result = await run( [ 'wp/v2', 'widgets', 'create' ] );
		expect( result.exitCode ).toBe( 1 );
		expect( result.stderr ).toContain( '--title is required.' );
	} );

	it( 'does not require create-time fields on a partial update', async () => {
		const result = await run( [
			'wp/v2',
			'widgets',
			'update',
			'2',
			'--format=json',
		] );
		expect( result.exitCode ).toBe( 0 );
	} );

	it( 'rejects list when a required query arg is missing, before sending the request', async () => {
		const result = await run( [ 'wp/v2', 'file-size', 'list' ] );
		expect( result.exitCode ).toBe( 1 );
		expect( result.stderr ).toContain( '--url is required.' );
	} );

	it( 'accepts list once the required query arg is provided', async () => {
		const result = await run( [
			'wp/v2',
			'file-size',
			'list',
			'url=https://example.com/image.jpg',
			'--format=json',
		] );
		expect( result.exitCode ).toBe( 0 );
		const body = JSON.parse( result.stdout );
		expect( body.url ).toBe( 'https://example.com/image.jpg' );
	} );

	it( 'deletes an item by id', async () => {
		const result = await run( [ 'wp/v2', 'widgets', 'delete', '1' ] );
		expect( result.exitCode ).toBe( 0 );
		expect( result.stdout ).toContain( 'Success' );
	} );

	it( 'prints general usage for `help` with no arguments', async () => {
		const result = await run( [ 'help' ] );
		expect( result.exitCode ).toBe( 0 );
		expect( result.stdout ).toContain( 'Usage:' );
		expect( result.stdout ).toContain( 'Examples:' );
	} );

	it( 'lists routes for `help <namespace>`, same as bare <namespace>', async () => {
		const result = await run( [ 'help', 'wp/v2' ] );
		expect( result.exitCode ).toBe( 0 );
		expect( result.stdout ).toContain( 'widgets' );
	} );

	it( 'shows route schema for `help <namespace> <route>`', async () => {
		const result = await run( [ 'help', 'wp/v2', 'widgets' ] );
		expect( result.exitCode ).toBe( 0 );
		expect( result.stdout ).toContain( 'per_page' );
		expect( result.stdout ).toContain( '--title=<string>' );
	} );

	it( 'shows list-verb help with the matching collection GET args', async () => {
		const result = await run( [ 'help', 'wp/v2', 'widgets', 'list' ] );
		expect( result.exitCode ).toBe( 0 );
		expect( result.stdout ).toContain(
			'usage: wp-rest-cli wp/v2 widgets list'
		);
		expect( result.stdout ).toContain( '[--per_page=<per_page>]' );
	} );

	it( 'shows create-verb help with the matching collection POST args', async () => {
		const result = await run( [ 'help', 'wp/v2', 'widgets', 'create' ] );
		expect( result.exitCode ).toBe( 0 );
		expect( result.stdout ).toContain( 'The widget title.' );
	} );

	it( 'shows delete-verb help without performing the delete', async () => {
		const result = await run( [ 'help', 'wp/v2', 'widgets', 'delete' ] );
		expect( result.exitCode ).toBe( 0 );
		expect( result.stdout ).toContain( '--force' );
		expect( result.stdout ).not.toContain( 'Success' );

		// Widget 2 (from the earlier "creates an item" test) must be untouched.
		const stillThere = await run( [
			'wp/v2',
			'widgets',
			'get',
			'2',
			'--field=id',
		] );
		expect( stillThere.stdout.trim() ).toBe( '2' );
	} );

	it( 'folds an unrecognised verb into the route for `help`, surfacing the live 404 instead of a local error', async () => {
		const result = await run( [ 'help', 'wp/v2', 'widgets', 'bogus' ] );
		expect( result.exitCode ).toBe( 1 );
		expect( result.stderr ).toContain(
			'No route was found matching the URL and request method.'
		);
	} );

	it( 'lists a route that only exists in parameterised form, grouped by its first segment', async () => {
		const result = await run( [ 'wp/v2', '--format=json' ] );
		expect( result.exitCode ).toBe( 0 );
		const rows = JSON.parse( result.stdout ) as Array< {
			route: string;
			verbs: string;
		} >;
		expect( rows.some( ( r ) => r.route === 'global-styles' ) ).toBe(
			true
		);
		expect( rows.some( ( r ) => r.route === 'global-styles/themes' ) ).toBe(
			false
		);
	} );

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
			expect( rows ).toEqual( [
				{ route: 'parts', verbs: '(subcommand)' },
			] );
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

	it( 'shows a param-required note when introspecting a route with no bare collection', async () => {
		const result = await run( [ 'wp/v2', 'global-styles', 'themes' ] );
		expect( result.exitCode ).toBe( 0 );
		expect( result.stdout ).toContain(
			'This route only exists with a value in place of its URL parameter'
		);
		expect( result.stdout ).toContain( 'context' );
	} );

	it( "shows a trailing-parameter route's own URL parameter as required, even though WordPress declares it required: false in the schema", async () => {
		const result = await run( [ 'wp/v2', 'global-styles', 'themes' ] );
		expect( result.exitCode ).toBe( 0 );
		// A required arg (including the route's own forced-required URL
		// parameter) is shown bare, no brackets — an optional one is bracketed.
		expect( result.stdout ).toContain(
			'--stylesheet=<string> (this route’s own URL parameter)'
		);
		expect( result.stdout ).not.toContain( '[--stylesheet=<string>]' );
		expect( result.stdout ).toContain( '[--context=<string>]' );
		expect( result.stdout ).toContain( 'default: "view"' );
		expect( result.stdout ).toContain( 'options:' );
		expect( result.stdout ).toContain( '- view' );
		expect( result.stdout ).toContain( '- edit' );
		expect( result.stdout ).toContain( '- embed' );
	} );

	it( "shows a mid-path route's own URL parameter as required, both in the detailed listing and the usage synopsis", async () => {
		const result = await run( [ 'wp/v2', 'posts', 'revisions' ] );
		expect( result.exitCode ).toBe( 0 );
		expect( result.stdout ).toContain(
			'--parent=<integer> (this route’s own URL parameter)'
		);
		// list's synopsis line pulls args in inline (unlike get/exists, which are
		// hardcoded to just <id>) — the parameter shows bare, not bracketed.
		// The route itself is shown as separate words ("posts revisions"), the
		// way it's actually typed at the CLI, not the internal "posts/revisions".
		expect( result.stdout ).toContain(
			'usage: wp-rest-cli wp/v2 posts revisions list --parent=<parent>'
		);
	} );

	it( 'performs a get against a route addressed as separate CLI arguments', async () => {
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
			expect( result.stdout ).toContain(
				'doesn\'t appear to support "get"'
			);
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
			const result = await run( [
				'wp/v2',
				'widgets',
				'exists',
				'999999',
			] );
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
				items.filter( ( w ) => w.title.rendered === 'Bulk widget' )
					.length
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
	} );

	describe( '--debug', () => {
		it( 'logs each HTTP request/response to stderr, leaving stdout as clean formatted output', async () => {
			const result = await run( [
				'wp/v2',
				'widgets',
				'list',
				'--debug',
				'--format=json',
			] );
			expect( result.exitCode ).toBe( 0 );
			expect( result.stderr ).toContain(
				`GET ${ fixture.baseUrl }/wp-json/wp/v2/widgets`
			);
			expect( result.stderr ).toMatch( /← \d+/ );
			expect( () => JSON.parse( result.stdout ) ).not.toThrow();
		} );

		it( 'redacts the Authorization header instead of logging the raw credential', async () => {
			const result = await run( [
				'wp/v2',
				'widgets',
				'list',
				'--debug',
				'--username=admin',
				'--password=secret-pass',
			] );
			const encoded =
				Buffer.from( 'admin:secret-pass' ).toString( 'base64' );
			expect( result.stderr ).toContain(
				'Authorization: Basic <redacted>'
			);
			expect( result.stderr ).not.toContain( encoded );
		} );

		it( 'logs the site-discovery requests too', async () => {
			const result = await run( [ 'wp/v2', '--debug' ] );
			expect( result.exitCode ).toBe( 0 );
			expect( result.stderr ).toContain( `HEAD ${ fixture.baseUrl }` );
		} );
	} );

	describe( 'meta', () => {
		async function createWidget( title: string ): Promise< string > {
			const result = await run( [
				'wp/v2',
				'widgets',
				'create',
				`--title=${ title }`,
				'--format=json',
			] );
			return String( JSON.parse( result.stdout ).id );
		}

		it( 'shows the meta usage synopsis for a route that supports meta', async () => {
			const result = await run( [ 'wp/v2', 'widgets' ] );
			expect( result.exitCode ).toBe( 0 );
			expect( result.stdout ).toContain(
				'usage: wp-rest-cli wp/v2 widgets meta add <id> <key>'
			);
			expect( result.stdout ).toContain(
				'wp-rest-cli wp/v2 widgets meta list <id>'
			);
		} );

		it( 'also lists meta as a discoverable sub-route, alongside the detailed synopsis', async () => {
			const result = await run( [ 'wp/v2', 'widgets' ] );
			expect( result.exitCode ).toBe( 0 );
			expect( result.stdout ).toContain(
				'This route also has nested sub-routes:'
			);
			expect( result.stdout ).toMatch( /meta\s*\|\s*\(subcommand\)/ );
		} );

		it( 'sets and reads back a meta value with update/get', async () => {
			const id = await createWidget( 'Meta target' );
			const updateResult = await run( [
				'wp/v2',
				'widgets',
				'meta',
				'update',
				id,
				'color',
				'blue',
			] );
			expect( updateResult.exitCode ).toBe( 0 );
			expect( updateResult.stdout ).toContain( 'Success' );

			const getResult = await run( [
				'wp/v2',
				'widgets',
				'meta',
				'get',
				id,
				'color',
			] );
			expect( getResult.exitCode ).toBe( 0 );
			expect( getResult.stdout.trim() ).toBe( 'blue' );
		} );

		it( 'add behaves the same as update (no separate multi-value semantics over REST)', async () => {
			const id = await createWidget( 'Meta add target' );
			await run( [
				'wp/v2',
				'widgets',
				'meta',
				'add',
				id,
				'color',
				'green',
			] );
			const getResult = await run( [
				'wp/v2',
				'widgets',
				'meta',
				'get',
				id,
				'color',
			] );
			expect( getResult.stdout.trim() ).toBe( 'green' );
		} );

		it( 'lists every meta key as key/value rows', async () => {
			const id = await createWidget( 'Meta list target' );
			await run( [
				'wp/v2',
				'widgets',
				'meta',
				'update',
				id,
				'color',
				'red',
			] );
			const result = await run( [
				'wp/v2',
				'widgets',
				'meta',
				'list',
				id,
				'--format=json',
			] );
			expect( result.exitCode ).toBe( 0 );
			expect( JSON.parse( result.stdout ) ).toEqual( [
				{ key: 'color', value: 'red' },
			] );
		} );

		it( 'deletes a whole meta key', async () => {
			const id = await createWidget( 'Meta delete target' );
			await run( [
				'wp/v2',
				'widgets',
				'meta',
				'update',
				id,
				'color',
				'yellow',
			] );
			const del = await run( [
				'wp/v2',
				'widgets',
				'meta',
				'delete',
				id,
				'color',
			] );
			expect( del.exitCode ).toBe( 0 );
			const getResult = await run( [
				'wp/v2',
				'widgets',
				'meta',
				'get',
				id,
				'color',
			] );
			expect( getResult.exitCode ).toBe( 1 );
		} );

		it( 'removes every matching value from an array-type meta field via delete <key> <value>', async () => {
			const id = await createWidget( 'Meta array target' );
			await run( [
				'wp/v2',
				'widgets',
				'meta',
				'update',
				id,
				'tags',
				'["a","b","a"]',
			] );
			await run( [
				'wp/v2',
				'widgets',
				'meta',
				'delete',
				id,
				'tags',
				'"a"',
			] );
			const getResult = await run( [
				'wp/v2',
				'widgets',
				'meta',
				'get',
				id,
				'tags',
				'--format=json',
			] );
			expect( JSON.parse( getResult.stdout ) ).toEqual( [ 'b' ] );
		} );

		it( 'dedupes an array-type meta field with clean-duplicates', async () => {
			const id = await createWidget( 'Meta dedupe target' );
			await run( [
				'wp/v2',
				'widgets',
				'meta',
				'update',
				id,
				'tags',
				'["a","b","a","b"]',
			] );
			const clean = await run( [
				'wp/v2',
				'widgets',
				'meta',
				'clean-duplicates',
				id,
				'tags',
			] );
			expect( clean.exitCode ).toBe( 0 );
			expect( clean.stdout ).toContain( 'removed' );
			const getResult = await run( [
				'wp/v2',
				'widgets',
				'meta',
				'get',
				id,
				'tags',
				'--format=json',
			] );
			expect( JSON.parse( getResult.stdout ) ).toEqual( [ 'a', 'b' ] );
		} );

		it( 'reads a nested value with pluck and writes one with patch', async () => {
			const id = await createWidget( 'Meta patch target' );
			await run( [
				'wp/v2',
				'widgets',
				'meta',
				'update',
				id,
				'color',
				'{"shade":"dark"}',
			] );
			const pluck = await run( [
				'wp/v2',
				'widgets',
				'meta',
				'pluck',
				id,
				'color',
				'shade',
			] );
			expect( pluck.stdout.trim() ).toBe( 'dark' );

			await run( [
				'wp/v2',
				'widgets',
				'meta',
				'patch',
				'update',
				id,
				'color',
				'shade',
				'light',
			] );
			const after = await run( [
				'wp/v2',
				'widgets',
				'meta',
				'pluck',
				id,
				'color',
				'shade',
			] );
			expect( after.stdout.trim() ).toBe( 'light' );
		} );
	} );

	describe( '--no-color', () => {
		// execa's stdio is always a pipe, never a TTY - color is on by
		// default regardless, so these don't need to fake a TTY to assert on.
		function runRaw( args: string[] ) {
			return execa(
				'tsx',
				[ cliEntry, ...args, `--url=${ fixture.baseUrl }`, '--quiet' ],
				{
					reject: false,
					preferLocal: true,
					env: { FORCE_COLOR: undefined, NO_COLOR: undefined },
				}
			);
		}

		it( 'colorizes by default, even when piped', async () => {
			const result = await runRaw( [ 'config', 'get' ] );
			expect( result.exitCode ).toBe( 0 );
			expect( result.stdout ).toMatch( /\x1b\[/ );
		} );

		it( '--no-color disables color', async () => {
			const result = await runRaw( [ '--no-color', 'config', 'get' ] );
			expect( result.exitCode ).toBe( 0 );
			expect( result.stdout ).not.toMatch( /\x1b\[/ );
		} );
	} );
} );
