/**
 * External dependencies
 */
import { execa } from 'execa';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Internal dependencies
 */
import {
	getOAuth2RouteHitCounts,
	getRevokedApplicationPasswordUuids,
	startFixture,
	type Fixture,
} from './fixtures/server.js';

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
			'   or: wp-rest-cli wp/v2 widgets create --title=<title> [--content=<content>] [--meta=<meta>] [--<field>=<value>]'
		);
		expect( lines[ 3 ] ).toBe(
			'   or: wp-rest-cli wp/v2 widgets update <id> --title=<title> [--content=<content>] [--meta=<meta>] [--<field>=<value>]'
		);
		expect( lines[ 4 ] ).toBe(
			'   or: wp-rest-cli wp/v2 widgets delete <id> [--force]'
		);
		expect( lines[ 5 ] ).toBe(
			'   or: wp-rest-cli wp/v2 widgets exists <id>'
		);
		expect( lines[ 6 ] ).toBe(
			'   or: wp-rest-cli wp/v2 widgets generate [--count=<count>] --title=<title> [--content=<content>] [--meta=<meta>] [--<field>=<value>]'
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

	it( 'sends --content=<value> as a plain field, not the (renamed) raw-body-override flag', async () => {
		const result = await run( [
			'wp/v2',
			'widgets',
			'create',
			'--title=Plain content',
			'--content=Hello there',
			'--format=json',
		] );
		expect( result.exitCode ).toBe( 0 );
		const body = JSON.parse( result.stdout );
		expect( body.content.rendered ).toBe( 'Hello there' );
	} );

	it( 'JSON-parses an object-typed field passed via field=value, instead of sending it as a literal string', async () => {
		const result = await run( [
			'wp/v2',
			'widgets',
			'create',
			'--title=Widget with meta',
			'--meta={"color":"red"}',
			'--format=json',
		] );
		expect( result.exitCode ).toBe( 0 );
		const body = JSON.parse( result.stdout );
		expect( body.meta ).toEqual( { color: 'red' } );
	} );

	it( '--body=<json> still overrides the request body, merged under field=value args', async () => {
		// The required-field check only inspects field=value tokens, not
		// --body's JSON contents, so --title still has to be passed
		// separately — this asserts fields win where they overlap with
		// --body (title), and --body alone supplies what fields don't (meta).
		const result = await run( [
			'wp/v2',
			'widgets',
			'create',
			'--title=From fields',
			'--body={"title":"From body","meta":{"color":"blue"}}',
			'--format=json',
		] );
		expect( result.exitCode ).toBe( 0 );
		const body = JSON.parse( result.stdout );
		expect( body.title.rendered ).toBe( 'From fields' );
		expect( body.meta ).toEqual( { color: 'blue' } );
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

	it( "shows a hybrid route's nested-children note as WP-CLI-style rows, not an ASCII table", async () => {
		const result = await run( [ 'wp/v2', 'global-styles', 'themes' ] );
		expect( result.exitCode ).toBe( 0 );
		expect( result.stdout ).toContain(
			'This route also has nested sub-routes:'
		);
		expect( result.stdout ).toMatch( /variations\s+list, get, exists/ );
		expect( result.stdout ).not.toContain( '+-' );
	} );

	it( 'shows a pure-container route (no schema of its own) as a WP-CLI-native SUBCOMMANDS page', async () => {
		const result = await run( [ 'wp/v2', 'posts' ] );
		expect( result.exitCode ).toBe( 0 );
		expect( result.stdout ).toContain( 'NAME' );
		expect( result.stdout ).toContain( 'wp-rest-cli wp/v2 posts' );
		expect( result.stdout ).toContain( 'SYNOPSIS' );
		expect( result.stdout ).toContain( 'wp-rest-cli wp/v2 posts <route>' );
		expect( result.stdout ).toContain( 'SUBCOMMANDS' );
		expect( result.stdout ).toMatch( /revisions\s+list, get, exists/ );
		expect( result.stdout ).not.toContain( '+-' );
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

	describe( 'partial credentials', () => {
		// A lone --username/--password (or WP_USERNAME/WP_PASSWORD) must be
		// rejected rather than silently falling through to whatever `wp auth`
		// credential happens to be stored for the site — that would mean
		// requests running as a different, unintended account with no warning.
		it( 'rejects --username given without --password', async () => {
			const result = await run( [
				'wp/v2',
				'widgets',
				'list',
				'--username=admin',
			] );
			expect( result.exitCode ).toBe( 1 );
			expect( result.stderr ).toContain( 'must be given together' );
		} );

		it( 'rejects --password given without --username', async () => {
			const result = await run( [
				'wp/v2',
				'widgets',
				'list',
				'--password=secret-pass',
			] );
			expect( result.exitCode ).toBe( 1 );
			expect( result.stderr ).toContain( 'must be given together' );
		} );

		it( 'rejects an explicitly-empty --username paired with a real --password', async () => {
			const result = await run( [
				'wp/v2',
				'widgets',
				'list',
				'--username=',
				'--password=secret-pass',
			] );
			expect( result.exitCode ).toBe( 1 );
			expect( result.stderr ).toContain( 'must not be empty' );
		} );

		it( 'rejects both --username and --password given but empty, rather than silently falling back to a stored credential', async () => {
			const result = await run( [
				'wp/v2',
				'widgets',
				'list',
				'--username=',
				'--password=',
			] );
			expect( result.exitCode ).toBe( 1 );
			expect( result.stderr ).toContain( 'must not be empty' );
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

		it( 'lists meta as a discoverable sub-route, without repeating its own full meta usage synopsis', async () => {
			const result = await run( [ 'wp/v2', 'widgets' ] );
			expect( result.exitCode ).toBe( 0 );
			expect( result.stdout ).toContain(
				'This route also has nested sub-routes:'
			);
			expect( result.stdout ).toMatch( /meta\s+\(subcommand\)/ );
			// The full "usage: ... meta add/clean-duplicates/.../update"
			// block is redundant once meta is already listed above as a
			// discoverable subcommand — `wp <namespace> <route> meta` (or
			// `wp help ... meta`) is where that detail belongs instead.
			expect( result.stdout ).not.toContain(
				'usage: wp-rest-cli wp/v2 widgets meta add <id> <key>'
			);
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

	describe( 'auth', () => {
		// Every stored credential goes through `conf`, keyed off
		// XDG_CONFIG_HOME - isolating it to a scratch directory per test file
		// (rather than reusing `run()`'s default env) keeps these tests from
		// reading or clobbering a real config file on the machine running them.
		let authConfigDir: string;

		beforeAll( async () => {
			authConfigDir = await mkdtemp(
				join( tmpdir(), 'wp-rest-cli-auth-it-' )
			);
		} );

		afterAll( async () => {
			await rm( authConfigDir, { recursive: true, force: true } );
		} );

		// `wp auth` now requires a `<type>` positional right after `auth`
		// (`wp auth <type> <verb> ...`) — inserted here centrally, rather than
		// in every call site below, so this is the one place that would need
		// to change if a test ever needed to exercise a different type.
		const AUTH_TYPE = 'application-passwords';

		function runAuth( args: string[] ) {
			const withType =
				args[ 0 ] === 'auth'
					? [ args[ 0 ], AUTH_TYPE, ...args.slice( 1 ) ]
					: args;
			return execa(
				'tsx',
				[ cliEntry, ...withType, '--quiet', '--no-color' ],
				{
					reject: false,
					preferLocal: true,
					env: { XDG_CONFIG_HOME: authConfigDir },
				}
			);
		}

		// Best-effort cleanup between tests that each need a known starting
		// state for `fixture.baseUrl` regardless of what earlier tests in this
		// file left behind — `runAuth` never rejects (execa's `reject: false`),
		// so a "nothing to remove" failure here is fine.
		async function removeIfPresent( url: string ) {
			await runAuth( [ 'auth', 'remove', url ] );
		}

		/**
		 * Drives a full `auth login` round-trip against `fixture.baseUrl`,
		 * simulating the browser's approval with the given username, and
		 * returns once the CLI process has exited (asserting success).
		 * @param userLogin The username to simulate approving as.
		 * @param url       The site to log in against (defaults to the fixture).
		 */
		async function simulateLogin(
			userLogin: string,
			url = fixture.baseUrl
		) {
			const child = execa(
				'tsx',
				[
					cliEntry,
					'auth',
					AUTH_TYPE,
					'login',
					url,
					'--quiet',
					'--no-color',
				],
				{
					reject: false,
					preferLocal: true,
					env: { XDG_CONFIG_HOME: authConfigDir },
				}
			);
			let stdout = '';
			const authorizeUrlFound = new Promise< string >( ( resolve ) => {
				child.stdout?.on( 'data', ( chunk: Buffer ) => {
					stdout += chunk.toString();
					const match = stdout.match(
						/https?:\/\/\S*authorize-application\.php\?\S+/
					);
					if ( match ) {
						resolve( match[ 0 ] );
					}
				} );
			} );
			const authorizeUrl = await authorizeUrlFound;
			const successUrl = new URL( authorizeUrl ).searchParams.get(
				'success_url'
			) as string;
			await fetch(
				`${ successUrl }?user_login=${ userLogin }&password=pw-${ userLogin }`
			);
			const result = await child;
			expect( result.exitCode ).toBe( 0 );
			return result;
		}

		it( 'adds and lists a manually-supplied credential', async () => {
			const add = await runAuth( [
				'auth',
				'add',
				fixture.baseUrl,
				'--username=admin',
				'--password=secret-app-pw',
			] );
			expect( add.exitCode ).toBe( 0 );
			expect( add.stdout ).toContain( 'Success' );

			const list = await runAuth( [ 'auth', 'list', '--format=json' ] );
			expect( list.exitCode ).toBe( 0 );
			expect( JSON.parse( list.stdout ) ).toContainEqual( {
				url: fixture.baseUrl,
				username: 'admin',
				authMethod: 'password',
				default: '',
			} );
		} );

		it( 'falls back to the global --url flag when the positional <url> is omitted', async () => {
			await removeIfPresent( fixture.baseUrl );

			// No positional <url> after `add` here — only the global --url
			// flag, which every other command already accepts. This is what a
			// user reasonably expects to work rather than needing to repeat
			// the site twice.
			const add = await execa(
				'tsx',
				[
					cliEntry,
					'auth',
					AUTH_TYPE,
					'add',
					`--url=${ fixture.baseUrl }`,
					'--username=admin',
					'--password=secret-app-pw',
					'--quiet',
					'--no-color',
				],
				{
					reject: false,
					preferLocal: true,
					env: { XDG_CONFIG_HOME: authConfigDir },
				}
			);
			expect( add.exitCode ).toBe( 0 );
			expect( add.stdout ).toContain( 'Success' );

			const list = await runAuth( [ 'auth', 'list', '--format=json' ] );
			expect( JSON.parse( list.stdout ) ).toContainEqual(
				expect.objectContaining( {
					url: fixture.baseUrl,
					username: 'admin',
				} )
			);

			await removeIfPresent( fixture.baseUrl );
		} );

		it( 'requires both --username and --password for add', async () => {
			const result = await runAuth( [
				'auth',
				'add',
				fixture.baseUrl,
				'--username=admin',
			] );
			expect( result.exitCode ).toBe( 1 );
			expect( result.stderr ).toContain(
				'requires --username and --password'
			);
		} );

		it( 'uses a stored credential automatically when no --username/--password flags are given', async () => {
			await runAuth( [
				'auth',
				'add',
				fixture.baseUrl,
				'--username=admin',
				'--password=secret-app-pw',
			] );
			const result = await runAuth( [
				'wp/v2',
				'widgets',
				'list',
				`--url=${ fixture.baseUrl }`,
				'--debug',
			] );
			expect( result.exitCode ).toBe( 0 );
			expect( result.stderr ).toContain(
				'Authorization: Basic <redacted>'
			);
		} );

		it( 'removes a stored credential, and errors on a second removal', async () => {
			await runAuth( [
				'auth',
				'add',
				fixture.baseUrl,
				'--username=admin',
				'--password=secret-app-pw',
			] );
			const removed = await runAuth( [
				'auth',
				'remove',
				fixture.baseUrl,
			] );
			expect( removed.exitCode ).toBe( 0 );
			expect( removed.stdout ).toContain( 'Success' );

			const removedAgain = await runAuth( [
				'auth',
				'remove',
				fixture.baseUrl,
			] );
			expect( removedAgain.exitCode ).toBe( 1 );
			expect( removedAgain.stderr ).toContain(
				'No stored credential for'
			);
		} );

		it( 'sets and reports the default site via use/status', async () => {
			const use = await runAuth( [ 'auth', 'use', fixture.baseUrl ] );
			expect( use.exitCode ).toBe( 0 );

			const status = await runAuth( [ 'auth', 'status' ] );
			expect( status.exitCode ).toBe( 0 );
			expect( status.stdout ).toContain(
				`default site: ${ fixture.baseUrl }`
			);
		} );

		it( 'reports a clear error when logging in against a site with no Application Passwords support', async () => {
			const result = await runAuth( [
				'auth',
				'login',
				`${ fixture.baseUrl }/no-app-passwords`,
			] );
			expect( result.exitCode ).toBe( 1 );
			expect( result.stderr ).toContain(
				'does not support Application Passwords'
			);
			expect( result.stderr ).toContain(
				'wp auth application-passwords add'
			);
		} );

		it( 'runs the full browser-based login flow via the local callback server', async () => {
			const result = await simulateLogin( 'cli-test-user' );
			expect( result.stdout ).toContain( 'Success' );
			expect( result.stdout ).toContain( 'cli-test-user' );

			await runAuth( [ 'auth', 'use', fixture.baseUrl ] );
			const list = await runAuth( [ 'auth', 'list', '--format=json' ] );
			expect( JSON.parse( list.stdout ) ).toContainEqual( {
				url: fixture.baseUrl,
				username: 'cli-test-user',
				authMethod: 'application-password',
				default: '*',
			} );
		} );

		it( 'blocks auth add when the site rejects the credentials (401)', async () => {
			await removeIfPresent( fixture.baseUrl );

			const result = await runAuth( [
				'auth',
				'add',
				fixture.baseUrl,
				'--username=admin',
				'--password=wrong-password',
			] );
			expect( result.exitCode ).toBe( 1 );
			expect( result.stderr ).toContain(
				'These credentials were rejected by the site'
			);

			const list = await runAuth( [ 'auth', 'list' ] );
			expect( list.stdout ).toContain( 'No stored credentials' );
		} );

		it( '--skip-verify saves a rejected credential anyway, with no verification', async () => {
			await removeIfPresent( fixture.baseUrl );

			const result = await runAuth( [
				'auth',
				'add',
				fixture.baseUrl,
				'--username=admin',
				'--password=wrong-password',
				'--skip-verify',
			] );
			expect( result.exitCode ).toBe( 0 );
			expect( result.stdout ).toContain( 'Success' );

			const list = await runAuth( [ 'auth', 'list', '--format=json' ] );
			const site = (
				JSON.parse( list.stdout ) as Array< {
					url: string;
					username: string;
					authMethod: string;
				} >
			 ).find( ( s ) => s.url === fixture.baseUrl );
			expect( site ).toMatchObject( {
				username: 'admin',
				authMethod: 'password',
			} );

			await removeIfPresent( fixture.baseUrl );
		} );

		it( 'still removes locally even when the site cannot revoke the credential remotely', async () => {
			await removeIfPresent( fixture.baseUrl );

			// "unrevokable" derives the fixture's reserved uuid
			// (`uuid-unrevokable`), which always 404s on DELETE —
			// deterministically exercises the "revoke failed, still removed
			// locally" path without depending on real network unreachability.
			await simulateLogin( 'unrevokable' );

			const removed = await runAuth( [
				'auth',
				'remove',
				fixture.baseUrl,
			] );
			expect( removed.exitCode ).toBe( 0 );
			expect( removed.stdout ).toContain(
				'could not revoke it on the site'
			);

			const list = await runAuth( [ 'auth', 'list' ] );
			expect( list.stdout ).toContain( 'No stored credentials' );
		} );

		it( 'revokes the previous Application Password when logging in again for the same site', async () => {
			await removeIfPresent( fixture.baseUrl );

			await simulateLogin( 'revoke-old-user' );
			await simulateLogin( 'revoke-new-user' );

			expect(
				getRevokedApplicationPasswordUuids().has(
					'uuid-revoke-old-user'
				)
			).toBe( true );

			await removeIfPresent( fixture.baseUrl );
		} );

		it( 'auth remove --all revokes what it can and clears every stored credential', async () => {
			// Several sequential `tsx` subprocess spawns (login, add, remove --all,
			// list) push this past vitest's 5s default testTimeout.
			await removeIfPresent( fixture.baseUrl );
			const secondSite = `${ fixture.baseUrl }/no-app-passwords`;
			await removeIfPresent( secondSite );

			await simulateLogin( 'remove-all-user' );
			await runAuth( [
				'auth',
				'add',
				secondSite,
				'--username=admin',
				'--password=whatever',
				'--skip-verify',
			] );

			const result = await runAuth( [ 'auth', 'remove', '--all' ] );
			expect( result.exitCode ).toBe( 0 );
			expect( result.stdout ).toContain( 'removed 2 stored credential' );
			expect( result.stdout ).toContain( 'revoked 1' );

			expect(
				getRevokedApplicationPasswordUuids().has(
					'uuid-remove-all-user'
				)
			).toBe( true );

			const list = await runAuth( [ 'auth', 'list' ] );
			expect( list.stdout ).toContain( 'No stored credentials' );
		} );

		it( 'wp config rotate-key re-encrypts the store without losing data', async () => {
			await removeIfPresent( fixture.baseUrl );
			await runAuth( [
				'auth',
				'add',
				fixture.baseUrl,
				'--username=admin',
				'--password=whatever',
				'--skip-verify',
			] );
			await runAuth( [ 'auth', 'use', fixture.baseUrl ] );

			const rotate = await runAuth( [ 'config', 'rotate-key' ] );
			expect( rotate.exitCode ).toBe( 0 );
			expect( rotate.stdout ).toContain( 'Success' );

			const list = await runAuth( [ 'auth', 'list', '--format=json' ] );
			const site = (
				JSON.parse( list.stdout ) as Array< { url: string } >
			 ).find( ( s ) => s.url === fixture.baseUrl );
			expect( site ).toBeDefined();

			const status = await runAuth( [ 'auth', 'status' ] );
			expect( status.stdout ).toContain(
				`default site: ${ fixture.baseUrl }`
			);

			await removeIfPresent( fixture.baseUrl );
		} );
	} );

	describe( 'oauth2', () => {
		// Same isolation rationale as the `auth` describe block above: a
		// scratch XDG_CONFIG_HOME per test file, not the default `run()`
		// helper, so these tests never read/clobber a real config file.
		let authConfigDir: string;

		beforeAll( async () => {
			authConfigDir = await mkdtemp(
				join( tmpdir(), 'wp-rest-cli-oauth2-it-' )
			);
		} );

		afterAll( async () => {
			await rm( authConfigDir, { recursive: true, force: true } );
		} );

		function runOAuth2( args: string[] ) {
			const withType =
				args[ 0 ] === 'auth'
					? [ args[ 0 ], 'oauth2', ...args.slice( 1 ) ]
					: args;
			return execa(
				'tsx',
				[ cliEntry, ...withType, '--quiet', '--no-color' ],
				{
					reject: false,
					preferLocal: true,
					env: { XDG_CONFIG_HOME: authConfigDir },
				}
			);
		}

		function runAppPasswordsAuth( args: string[] ) {
			const withType =
				args[ 0 ] === 'auth'
					? [ args[ 0 ], 'application-passwords', ...args.slice( 1 ) ]
					: args;
			return execa(
				'tsx',
				[ cliEntry, ...withType, '--quiet', '--no-color' ],
				{
					reject: false,
					preferLocal: true,
					env: { XDG_CONFIG_HOME: authConfigDir },
				}
			);
		}

		function runRestWithConfig( args: string[] ) {
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
					env: { XDG_CONFIG_HOME: authConfigDir },
				}
			);
		}

		async function removeIfPresent( url: string ) {
			await runOAuth2( [ 'auth', 'remove', url ] );
		}

		/**
		 * Spawns `wp auth oauth2 login`, captures the printed authorize URL,
		 * and returns the still-running child alongside that URL — callers
		 * decide how to complete the flow (follow the fixture's own redirect
		 * like a browser would, or hit the local callback server directly to
		 * simulate a tampered/invalid callback).
		 * @param options          Options.
		 * @param options.url      The site to log in against.
		 * @param options.clientId The OAuth2 client id to use.
		 * @param options.port     The fixed local callback port to bind to.
		 */
		function startOAuth2Login( options: {
			url?: string;
			clientId?: string;
			port: number;
		} ) {
			const {
				url = fixture.baseUrl,
				clientId = 'test-client-id',
				port,
			} = options;
			const child = execa(
				'tsx',
				[
					cliEntry,
					'auth',
					'oauth2',
					'login',
					url,
					`--client-id=${ clientId }`,
					`port=${ port }`,
					'--quiet',
					'--no-color',
				],
				{
					reject: false,
					preferLocal: true,
					env: { XDG_CONFIG_HOME: authConfigDir },
				}
			);
			let stdout = '';
			const authorizeUrlFound = new Promise< string >( ( resolve ) => {
				child.stdout?.on( 'data', ( chunk: Buffer ) => {
					stdout += chunk.toString();
					const match = stdout.match(
						/https?:\/\/\S*oauth2-authorize\?\S+/
					);
					if ( match ) {
						resolve( match[ 0 ] );
					}
				} );
			} );
			return { child, authorizeUrlFound };
		}

		/**
		 * Drives a full `auth oauth2 login` round-trip, following the printed
		 * authorize URL exactly the way a browser would — a plain `fetch`
		 * follows the fixture's redirect through to the CLI's own local
		 * callback server — and returns once the CLI process has exited.
		 * @param options          Options.
		 * @param options.url      The site to log in against.
		 * @param options.clientId The OAuth2 client id to use.
		 * @param options.port     The fixed local callback port to bind to.
		 */
		async function simulateOAuth2Login( options: {
			url?: string;
			clientId?: string;
			port: number;
		} ) {
			const { child, authorizeUrlFound } = startOAuth2Login( options );
			const authorizeUrl = await authorizeUrlFound;
			await fetch( authorizeUrl );
			return child;
		}

		it( 'adds and lists a client_credentials credential', async () => {
			await removeIfPresent( fixture.baseUrl );

			const add = await runOAuth2( [
				'auth',
				'add',
				fixture.baseUrl,
				'--client-id=test-client-id',
				'--client-secret=shh',
			] );
			expect( add.exitCode ).toBe( 0 );
			expect( add.stdout ).toContain( 'Success' );

			const list = await runOAuth2( [ 'auth', 'list', '--format=json' ] );
			expect( list.exitCode ).toBe( 0 );
			expect( JSON.parse( list.stdout ) ).toContainEqual( {
				url: fixture.baseUrl,
				clientId: 'test-client-id',
				grantType: 'client_credentials',
				default: '',
			} );

			await removeIfPresent( fixture.baseUrl );
		} );

		it( 'adds and lists a personal token credential, with no client id shown', async () => {
			await removeIfPresent( fixture.baseUrl );

			const add = await runOAuth2( [
				'auth',
				'add',
				fixture.baseUrl,
				'--token=test-personal-token-valid',
			] );
			expect( add.exitCode ).toBe( 0 );
			expect( add.stdout ).toContain( 'Success' );

			const list = await runOAuth2( [ 'auth', 'list', '--format=json' ] );
			expect( list.exitCode ).toBe( 0 );
			expect( JSON.parse( list.stdout ) ).toContainEqual( {
				url: fixture.baseUrl,
				clientId: '',
				grantType: 'personal_token',
				default: '',
			} );

			await runOAuth2( [ 'auth', 'use', fixture.baseUrl ] );
			const status = await runOAuth2( [ 'auth', 'status' ] );
			expect( status.exitCode ).toBe( 0 );
			expect( status.stdout ).toContain(
				'authenticated via OAuth2 (personal token)'
			);

			const request = await runRestWithConfig( [
				'wp/v2',
				'widgets',
				'list',
				'--use-auth=oauth2',
				'--debug',
			] );
			expect( request.exitCode ).toBe( 0 );
			expect( request.stderr ).toContain(
				'Authorization: Bearer <redacted>'
			);

			await removeIfPresent( fixture.baseUrl );
		} );

		it( 'blocks adding an unrecognized personal token unless skip-verify=true is passed', async () => {
			await removeIfPresent( fixture.baseUrl );

			const rejected = await runOAuth2( [
				'auth',
				'add',
				fixture.baseUrl,
				'--token=not-a-real-token',
			] );
			expect( rejected.exitCode ).toBe( 1 );
			expect( rejected.stderr ).toContain(
				'This personal token was rejected by the site'
			);

			const list = await runOAuth2( [ 'auth', 'list', '--format=json' ] );
			expect( list.stdout ).toContain( 'No stored credentials' );

			const skipped = await runOAuth2( [
				'auth',
				'add',
				fixture.baseUrl,
				'--token=not-a-real-token',
				'skip-verify=true',
			] );
			expect( skipped.exitCode ).toBe( 0 );
			expect( skipped.stdout ).toContain( 'Success' );

			const listAfter = await runOAuth2( [
				'auth',
				'list',
				'--format=json',
			] );
			expect( JSON.parse( listAfter.stdout ) ).toContainEqual(
				expect.objectContaining( {
					url: fixture.baseUrl,
					clientId: '',
					grantType: 'personal_token',
				} )
			);

			await removeIfPresent( fixture.baseUrl );
		} );

		it( 'rejects passing both --token and --client-id/--client-secret to add', async () => {
			await removeIfPresent( fixture.baseUrl );

			const result = await runOAuth2( [
				'auth',
				'add',
				fixture.baseUrl,
				'--token=test-personal-token-valid',
				'--client-id=test-client-id',
				'--client-secret=shh',
			] );
			expect( result.exitCode ).toBe( 1 );
			expect( result.stderr ).toContain(
				'pass either --token (a personal access token) or --client-id/--client-secret'
			);

			const list = await runOAuth2( [ 'auth', 'list', '--format=json' ] );
			expect( list.stdout ).toContain( 'No stored credentials' );
		} );

		it( 'falls back to the global --url flag when the positional <url> is omitted', async () => {
			await removeIfPresent( fixture.baseUrl );

			// No positional <url> after `add` here — only the global --url
			// flag, which every other command already accepts.
			const add = await execa(
				'tsx',
				[
					cliEntry,
					'auth',
					'oauth2',
					'add',
					`--url=${ fixture.baseUrl }`,
					'--client-id=test-client-id',
					'--client-secret=shh',
					'--quiet',
					'--no-color',
				],
				{
					reject: false,
					preferLocal: true,
					env: { XDG_CONFIG_HOME: authConfigDir },
				}
			);
			expect( add.exitCode ).toBe( 0 );
			expect( add.stdout ).toContain( 'Success' );

			const list = await runOAuth2( [ 'auth', 'list', '--format=json' ] );
			expect( JSON.parse( list.stdout ) ).toContainEqual(
				expect.objectContaining( {
					url: fixture.baseUrl,
					clientId: 'test-client-id',
				} )
			);

			await removeIfPresent( fixture.baseUrl );
		} );

		it( 'reports a hint about the Client Credentials Grant setting when the application does not support that grant', async () => {
			const result = await runOAuth2( [
				'auth',
				'add',
				fixture.baseUrl,
				'--client-id=test-client-id-no-cc',
				'--client-secret=shh',
			] );
			expect( result.exitCode ).toBe( 1 );
			expect( result.stderr ).toContain( 'Client Credentials Grant' );
		} );

		it( 'reports a distinct, more accurate error when the site never routes the request to client_credentials handling at all', async () => {
			// Distinguishes this from the "grant not enabled" case above:
			// `rest_missing_callback_param`/`rest_invalid_param` only ever
			// come from the plugin's authorization_code validation path, so
			// seeing one here — rather than the real handle_client_credentials()
			// failure's `oauth2.endpoints.token.invalid_client` — means the
			// request never reached client_credentials handling server-side
			// at all (an outdated plugin, stale opcode cache, or a WAF), not
			// that the grant is simply disabled for this Application.
			const result = await runOAuth2( [
				'auth',
				'add',
				fixture.baseUrl,
				'--client-id=test-client-id-wrong-code-path',
				'--client-secret=shh',
			] );
			expect( result.exitCode ).toBe( 1 );
			expect( result.stderr ).toContain(
				'responded as though this were an authorization_code request'
			);
			expect( result.stderr ).toContain(
				'not the same as the grant being disabled'
			);
			expect( result.stderr ).not.toContain( 'Client Credentials Grant' );
		} );

		it( 'runs the full authorization_code login flow via the local callback server', async () => {
			await removeIfPresent( fixture.baseUrl );

			const result = await simulateOAuth2Login( { port: 18801 } );
			expect( result.exitCode ).toBe( 0 );
			expect( result.stdout ).toContain( 'Success' );

			await runOAuth2( [ 'auth', 'use', fixture.baseUrl ] );
			const status = await runOAuth2( [ 'auth', 'status' ] );
			expect( status.stdout ).toContain(
				`default site: ${ fixture.baseUrl }`
			);
			expect( status.stdout ).toContain( 'authenticated via OAuth2' );

			await removeIfPresent( fixture.baseUrl );
		} );

		it( 'reports a clear error when the user cancels authorization (access_denied), without saving anything', async () => {
			const result = await simulateOAuth2Login( {
				port: 18802,
				clientId: 'test-client-id-deny',
			} );
			expect( result.exitCode ).toBe( 1 );
			expect( result.stderr.toLowerCase() ).toContain( 'denied' );

			const list = await runOAuth2( [ 'auth', 'list' ] );
			expect( list.stdout ).not.toContain( fixture.baseUrl );
		} );

		it( 'rejects a callback whose state does not match, without saving anything', async () => {
			const { child, authorizeUrlFound } = startOAuth2Login( {
				port: 18803,
			} );
			await authorizeUrlFound;

			// Hits the CLI's local callback server directly with a bogus
			// state, bypassing the fixture's own authorize endpoint entirely
			// — the CLI must reject this regardless of what a real
			// authorization server would ever send.
			await fetch(
				`http://127.0.0.1:18803/callback?code=whatever&state=not-the-real-state`
			);
			const result = await child;

			expect( result.exitCode ).toBe( 1 );
			expect( result.stderr ).toContain( 'state did not match' );

			const list = await runOAuth2( [ 'auth', 'list' ] );
			expect( list.stdout ).not.toContain( fixture.baseUrl );
		} );

		it( 'fails clearly when the callback port is already in use, rather than hanging', async () => {
			const port = 18804;
			const blocker = net.createServer();
			await new Promise< void >( ( resolve ) =>
				blocker.listen( port, '127.0.0.1', resolve )
			);
			try {
				const result = await execa(
					'tsx',
					[
						cliEntry,
						'auth',
						'oauth2',
						'login',
						fixture.baseUrl,
						'--client-id=test-client-id',
						`port=${ port }`,
						'--quiet',
						'--no-color',
					],
					{
						reject: false,
						preferLocal: true,
						env: { XDG_CONFIG_HOME: authConfigDir },
					}
				);
				expect( result.exitCode ).toBe( 1 );
				expect( result.stderr ).toContain( 'already in use' );
			} finally {
				await new Promise< void >( ( resolve ) =>
					blocker.close( () => resolve() )
				);
			}
		} );

		it( 'refuses to attempt anything against a site with no OAuth2 support, before any network call to the authorize/token routes', async () => {
			const before = getOAuth2RouteHitCounts();

			const noSiteUrl = `${ fixture.baseUrl }/no-app-passwords`;
			const loginResult = await runOAuth2( [
				'auth',
				'login',
				noSiteUrl,
				'--client-id=test-client-id',
			] );
			expect( loginResult.exitCode ).toBe( 1 );
			expect( loginResult.stderr ).toContain(
				"doesn't advertise OAuth2 support"
			);

			const addResult = await runOAuth2( [
				'auth',
				'add',
				noSiteUrl,
				'--client-id=test-client-id',
				'--client-secret=shh',
			] );
			expect( addResult.exitCode ).toBe( 1 );
			expect( addResult.stderr ).toContain(
				"doesn't advertise OAuth2 support"
			);

			const after = getOAuth2RouteHitCounts();
			expect( after.authorize ).toBe( before.authorize );
			expect( after.token ).toBe( before.token );
		} );

		it( 'requires --use-auth to disambiguate when both an application-passwords and an oauth2 credential are stored for the same site', async () => {
			await removeIfPresent( fixture.baseUrl );
			await runAppPasswordsAuth( [ 'auth', 'remove', fixture.baseUrl ] );

			await runAppPasswordsAuth( [
				'auth',
				'add',
				fixture.baseUrl,
				'--username=admin',
				'--password=secret-app-pw',
			] );
			await runOAuth2( [
				'auth',
				'add',
				fixture.baseUrl,
				'--client-id=test-client-id',
				'--client-secret=shh',
			] );

			const ambiguous = await runRestWithConfig( [
				'wp/v2',
				'widgets',
				'list',
			] );
			expect( ambiguous.exitCode ).toBe( 1 );
			expect( ambiguous.stderr ).toContain(
				'Both an application-passwords and an oauth2 credential are stored'
			);

			const withAppPasswords = await runRestWithConfig( [
				'wp/v2',
				'widgets',
				'list',
				'--use-auth=application-passwords',
				'--debug',
			] );
			expect( withAppPasswords.exitCode ).toBe( 0 );
			expect( withAppPasswords.stderr ).toContain(
				'Authorization: Basic <redacted>'
			);

			const withOAuth2 = await runRestWithConfig( [
				'wp/v2',
				'widgets',
				'list',
				'--use-auth=oauth2',
				'--debug',
			] );
			expect( withOAuth2.exitCode ).toBe( 0 );
			expect( withOAuth2.stderr ).toContain(
				'Authorization: Bearer <redacted>'
			);

			await runAppPasswordsAuth( [ 'auth', 'remove', fixture.baseUrl ] );
			await removeIfPresent( fixture.baseUrl );
		} );

		it( 'application-passwords remove --all does not remove a stored oauth2 credential for the same site', async () => {
			await runAppPasswordsAuth( [ 'auth', 'remove', fixture.baseUrl ] );
			await removeIfPresent( fixture.baseUrl );

			await runAppPasswordsAuth( [
				'auth',
				'add',
				fixture.baseUrl,
				'--username=admin',
				'--password=secret-app-pw',
			] );
			await runOAuth2( [
				'auth',
				'add',
				fixture.baseUrl,
				'--client-id=test-client-id',
				'--client-secret=shh',
			] );

			const removeAll = await runAppPasswordsAuth( [
				'auth',
				'remove',
				'--all',
			] );
			expect( removeAll.exitCode ).toBe( 0 );

			const oauth2List = await runOAuth2( [
				'auth',
				'list',
				'--format=json',
			] );
			// Matched on the credential fields only, not `default` — an
			// earlier test in this file may have already set this site as
			// the default `--url` via `auth oauth2 use`, and that's not what
			// this test is checking.
			expect( JSON.parse( oauth2List.stdout ) ).toContainEqual(
				expect.objectContaining( {
					url: fixture.baseUrl,
					clientId: 'test-client-id',
					grantType: 'client_credentials',
				} )
			);

			await removeIfPresent( fixture.baseUrl );
		} );

		it( 'removes a stored oauth2 credential purely locally, and errors on a second removal', async () => {
			await runOAuth2( [
				'auth',
				'add',
				fixture.baseUrl,
				'--client-id=test-client-id',
				'--client-secret=shh',
			] );

			const removed = await runOAuth2( [
				'auth',
				'remove',
				fixture.baseUrl,
			] );
			expect( removed.exitCode ).toBe( 0 );
			expect( removed.stdout ).toContain(
				'exposes no REST endpoint to revoke it'
			);

			const removedAgain = await runOAuth2( [
				'auth',
				'remove',
				fixture.baseUrl,
			] );
			expect( removedAgain.exitCode ).toBe( 1 );
			expect( removedAgain.stderr ).toContain(
				'No stored OAuth2 credential for'
			);
		} );
	} );

	describe( 'config store recovery', () => {
		// Each command is its own fresh process/module registry, unlike an
		// in-process dynamic re-import — this is the only way to actually
		// exercise `src/config.ts`'s recovery path for a config file that
		// can't be decrypted with the current key (e.g. the key file and
		// config file came from mismatched backups, or a `rotate-key` was
		// interrupted partway through).
		it( 'recovers instead of crashing when the config file cannot be decrypted, preserving a backup', async () => {
			const recoveryDir = await mkdtemp(
				join( tmpdir(), 'wp-rest-cli-recovery-it-' )
			);
			try {
				const set = await execa(
					'tsx',
					[
						cliEntry,
						'config',
						'set',
						'--url=https://example.com',
						'--quiet',
						'--no-color',
					],
					{
						reject: false,
						preferLocal: true,
						env: { XDG_CONFIG_HOME: recoveryDir },
					}
				);
				expect( set.exitCode ).toBe( 0 );

				const get = await execa(
					'tsx',
					[ cliEntry, 'config', 'get', '--quiet', '--no-color' ],
					{
						reject: false,
						preferLocal: true,
						env: { XDG_CONFIG_HOME: recoveryDir },
					}
				);
				const configFileLine = get.stdout
					.split( '\n' )
					.find( ( line ) => line.startsWith( 'config file:' ) );
				const configFilePath = configFileLine
					?.replace( 'config file:', '' )
					.trim() as string;
				expect( existsSync( configFilePath ) ).toBe( true );

				// Simulate the key file and config file falling out of sync.
				writeFileSync(
					configFilePath,
					Buffer.from( [ 0, 1, 2, 3, 255, 254 ] )
				);

				const afterCorruption = await execa(
					'tsx',
					[ cliEntry, 'config', 'get', '--quiet', '--no-color' ],
					{
						reject: false,
						preferLocal: true,
						env: { XDG_CONFIG_HOME: recoveryDir },
					}
				);
				expect( afterCorruption.exitCode ).toBe( 0 );
				expect( afterCorruption.stdout ).toContain( 'url: (not set)' );
				expect( afterCorruption.stderr ).toContain(
					'could not be read'
				);

				const dirEntries = readdirSync( dirname( configFilePath ) );
				expect(
					dirEntries.some( ( name ) =>
						name.includes( '.unreadable-' )
					)
				).toBe( true );
			} finally {
				await rm( recoveryDir, { recursive: true, force: true } );
			}
		} );
	} );
} );
