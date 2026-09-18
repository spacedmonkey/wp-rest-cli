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
	expect( JSON.parse( result.stdout ) ).toEqual( [ { namespace: 'wp/v2' } ] );
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
	expect( lines[ 5 ] ).toBe( '   or: wp-rest-cli wp/v2 widgets exists <id>' );
	expect( lines[ 6 ] ).toBe(
		'   or: wp-rest-cli wp/v2 widgets generate [--count=<count>] --title=<title> [--content=<content>] [--meta=<meta>] [--<field>=<value>]'
	);
} );

it( 'lists items for a route', async () => {
	const result = await run( [ 'wp/v2', 'widgets', 'list', '--format=json' ] );
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
	expect( rows.some( ( r ) => r.route === 'global-styles' ) ).toBe( true );
	expect( rows.some( ( r ) => r.route === 'global-styles/themes' ) ).toBe(
		false
	);
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
		const encoded = Buffer.from( 'admin:secret-pass' ).toString( 'base64' );
		expect( result.stderr ).toContain( 'Authorization: Basic <redacted>' );
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

describe( '--no-color', () => {
	// execa's stdio is always a pipe, never a TTY - color is on by
	// default regardless, so these don't need to fake a TTY to assert on.
	function runRaw( args: string[] ) {
		return runCli( [ ...args, `--url=${ fixture.baseUrl }`, '--quiet' ], {
			env: { FORCE_COLOR: undefined, NO_COLOR: undefined },
		} );
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
