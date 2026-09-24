/**
 * External dependencies
 */
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

/**
 * Internal dependencies
 */
import { formatOutput, setTruncateLength } from '../../src/core/formatter.js';

const posts = [
	{ id: 1, title: { rendered: 'Hello' }, link: 'https://example.com/1' },
	{ id: 2, title: { rendered: 'World' }, link: 'https://example.com/2' },
];

describe( 'formatOutput', () => {
	it( 'keeps nested structure for dotted --fields in json', async () => {
		const out = await formatOutput( posts, {
			format: 'json',
			fields: 'id,title.rendered',
			color: false,
		} );
		expect( JSON.parse( out ) ).toEqual( [
			{ id: 1, title: { rendered: 'Hello' } },
			{ id: 2, title: { rendered: 'World' } },
		] );
	} );

	it( 'prefers a literal dotted key and omits a missing dotted path', async () => {
		const out = await formatOutput(
			{ 'foo.bar': 1, id: 2 },
			{
				format: 'json',
				fields: 'foo.bar,nope.x,__proto__.polluted',
				color: false,
			}
		);
		expect( JSON.parse( out ) ).toEqual( { 'foo.bar': 1 } );
		expect( ( {} as Record< string, unknown > ).polluted ).toBeUndefined();
	} );

	it( 'renders json, preserving nested objects', async () => {
		const out = await formatOutput( posts[ 0 ], {
			format: 'json',
			color: false,
		} );
		expect( JSON.parse( out ) ).toEqual( posts[ 0 ] );
	} );

	it( 'applies --fields to json output, keeping nested shape', async () => {
		const out = await formatOutput( posts, {
			format: 'json',
			fields: 'id,link',
			color: false,
		} );
		expect( JSON.parse( out ) ).toEqual( [
			{ id: 1, link: 'https://example.com/1' },
			{ id: 2, link: 'https://example.com/2' },
		] );
	} );

	it( 'renders yaml', async () => {
		const out = await formatOutput(
			{ id: 1, name: 'test' },
			{ format: 'yaml', color: false }
		);
		expect( out ).toContain( 'id: 1' );
		expect( out ).toContain( 'name: test' );
	} );

	it( 'renders csv with flattened nested fields', async () => {
		const out = await formatOutput( posts, {
			format: 'csv',
			fields: 'id,title.rendered',
			color: false,
		} );
		const lines = out.trim().split( '\n' );
		expect( lines[ 0 ] ).toBe( 'id,title.rendered' );
		expect( lines[ 1 ] ).toBe( '1,Hello' );
	} );

	it( 'renders a table with headers and rows', async () => {
		const out = await formatOutput( posts, {
			format: 'table',
			fields: 'id,link',
			color: false,
		} );
		expect( out ).toContain( 'id' );
		expect( out ).toContain( 'link' );
		expect( out ).toContain( 'https://example.com/1' );
	} );

	it( 'renders ids as a space-joined list', async () => {
		const out = await formatOutput( posts, {
			format: 'ids',
			color: false,
		} );
		expect( out ).toBe( '1 2' );
	} );

	it( 'renders count as the row count', async () => {
		const out = await formatOutput( posts, {
			format: 'count',
			color: false,
		} );
		expect( out ).toBe( '2' );
	} );

	it( 'resolves --field for a single object, returning the raw nested value', async () => {
		const out = await formatOutput( posts[ 0 ], {
			format: 'table',
			field: 'title',
			color: false,
		} );
		expect( JSON.parse( out ) ).toEqual( { rendered: 'Hello' } );
	} );

	it( 'resolves --field with a dotted path', async () => {
		const out = await formatOutput( posts[ 0 ], {
			format: 'table',
			field: 'title.rendered',
			color: false,
		} );
		expect( out ).toBe( 'Hello' );
	} );

	it( 'resolves --field across an array of rows', async () => {
		const out = await formatOutput( posts, {
			format: 'table',
			field: 'id',
			color: false,
		} );
		expect( JSON.parse( out ) ).toEqual( [ 1, 2 ] );
	} );

	it( 'shows a friendly message for an empty table', async () => {
		const out = await formatOutput( [], { format: 'table', color: false } );
		expect( out ).toBe( 'No results.' );
	} );

	it( 'strips control characters from table cells instead of throwing', async () => {
		const rows = [
			{
				id: 1,
				title: { rendered: 'Tab\there' },
				content: { rendered: '<p>Line1</p>\r\n<p>Line2</p>' },
			},
		];
		const out = await formatOutput( rows, {
			format: 'table',
			fields: 'title.rendered,content.rendered',
			color: false,
		} );
		expect( out ).toContain( 'Tabhere' );
		expect( out ).toContain( '<p>Line1</p> <p>Line2</p>' );
	} );

	it( 'keeps full cells when truncation length is 0', async () => {
		setTruncateLength( 0 );
		try {
			const out = await formatOutput( [ { s: 'x'.repeat( 80 ) } ], {
				format: 'table',
				color: false,
			} );
			expect( out ).toContain( 'x'.repeat( 80 ) );
		} finally {
			setTruncateLength( 50 );
		}
	} );

	it( 'honours a custom truncation length', async () => {
		setTruncateLength( 10 );
		try {
			const out = await formatOutput( [ { s: 'x'.repeat( 80 ) } ], {
				format: 'table',
				color: false,
			} );
			expect( out ).toContain( `${ 'x'.repeat( 9 ) }…` );
			expect( out ).not.toContain( 'x'.repeat( 10 ) );
		} finally {
			setTruncateLength( 50 );
		}
	} );

	it( 'does not split emoji, and leaves 50-char cells alone', async () => {
		const out = await formatOutput(
			[ { a: '😀'.repeat( 60 ), b: 'y'.repeat( 50 ) } ],
			{ format: 'table', color: false }
		);
		expect( out ).toContain( `${ '😀'.repeat( 49 ) }…` );
		expect( out ).toContain( 'y'.repeat( 50 ) );
	} );

	it( 'shows the JSON for --fields naming a nested key', async () => {
		const out = await formatOutput( posts, {
			format: 'table',
			fields: 'title',
			color: false,
		} );
		expect( out ).toContain( '{"rendered":"Hello"}' );
	} );

	it( 'leaves a nested --fields key blank in csv', async () => {
		const out = await formatOutput( posts, {
			format: 'csv',
			fields: 'title',
			color: false,
		} );
		expect( out ).not.toContain( 'object' );
	} );

	it( 'skips truncation when the caller passes truncate: false', async () => {
		const out = await formatOutput( [ { u: 'x'.repeat( 80 ) } ], {
			format: 'table',
			color: false,
			truncate: false,
		} );
		expect( out ).toContain( 'x'.repeat( 80 ) );
	} );

	it( 'truncates long cells and shows the JSON for short nested values', async () => {
		const out = await formatOutput(
			[ { id: 1, s: 'x'.repeat( 80 ), o: { a: 1 }, a: [ 1 ] } ],
			{ format: 'table', color: false }
		);
		expect( out ).toContain( `${ 'x'.repeat( 49 ) }…` );
		expect( out ).not.toContain( 'x'.repeat( 50 ) );
		expect( out ).toContain( '{"a":1}' );
		expect( out ).toContain( '[1]' );
	} );

	it( 'truncates a long object/array cell to 50 chars ending in ...}/...]', async () => {
		const out = await formatOutput(
			[
				{
					o: { key: 'x'.repeat( 60 ) },
					a: Array.from( { length: 30 }, ( _, i ) => i ),
				},
			],
			{ format: 'table', color: false }
		);
		const objectJson = JSON.stringify( { key: 'x'.repeat( 60 ) } );
		const arrayJson = JSON.stringify(
			Array.from( { length: 30 }, ( _, i ) => i )
		);
		expect( out ).not.toContain( objectJson );
		expect( out ).not.toContain( arrayJson );
		expect( out ).toContain( `${ objectJson.slice( 0, 46 ) }...}` );
		expect( out ).toContain( `${ arrayJson.slice( 0, 46 ) }...]` );
	} );

	it( 'shows the full object/array when truncation is disabled', async () => {
		const value = { key: 'x'.repeat( 60 ) };
		const out = await formatOutput( [ { o: value } ], {
			format: 'table',
			color: false,
			truncate: false,
		} );
		expect( out ).toContain( JSON.stringify( value ) );
	} );

	it( 'shows the full object/array under --truncate-length=0', async () => {
		const value = { key: 'x'.repeat( 60 ) };
		try {
			setTruncateLength( 0 );
			const out = await formatOutput( [ { o: value } ], {
				format: 'table',
				color: false,
			} );
			expect( out ).toContain( JSON.stringify( value ) );
		} finally {
			setTruncateLength( 50 );
		}
	} );
} );

describe( 'formatOutput in agent mode', () => {
	beforeEach( () => {
		process.env.WRAPIDO_AGENT = '1';
	} );
	afterEach( () => {
		delete process.env.WRAPIDO_AGENT;
	} );

	it( 'prints compact json without _links/_embedded', async () => {
		const out = await formatOutput(
			[
				{
					id: 1,
					_links: { self: [] },
					_embedded: { a: [ { _links: 1, id: 2 } ] },
				},
			],
			{ format: 'json', color: false }
		);
		expect( out ).toBe( '[{"id":1}]' );
	} );

	it( 'keeps _links when --fields names it', async () => {
		const out = await formatOutput(
			{ id: 1, _links: { self: [] } },
			{
				format: 'json',
				fields: 'id,_links',
				color: false,
			}
		);
		expect( out ).toBe( '{"id":1,"_links":{"self":[]}}' );
	} );

	it.each( [ 'FALSE', ' 0 ', 'off', 'No' ] )(
		'treats %p as agent mode off',
		async ( value ) => {
			process.env.WRAPIDO_AGENT = value;
			const out = await formatOutput(
				{ id: 1 },
				{ format: 'json', color: false }
			);
			expect( out ).toContain( '\n' );
		}
	);

	it( 'prints an object-valued --field compactly', async () => {
		const out = await formatOutput(
			{ id: 1, title: { rendered: 'Hi' } },
			{
				format: 'json',
				field: 'title',
				color: false,
			}
		);
		expect( out ).toBe( '{"rendered":"Hi"}' );
	} );
} );
