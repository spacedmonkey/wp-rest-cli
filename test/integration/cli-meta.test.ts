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
