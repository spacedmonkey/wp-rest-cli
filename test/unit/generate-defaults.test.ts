/**
 * External dependencies
 */
import { describe, expect, it } from '@jest/globals';

/**
 * Internal dependencies
 */
import { generateDefaultValue } from '../../src/core/generate-defaults.js';
import type { EndpointArgSchema } from '../../src/types.js';

describe( 'generateDefaultValue', () => {
	it( 'prefers a declared default, regardless of index', () => {
		const arg: EndpointArgSchema = { type: 'string', default: 'draft' };
		expect( generateDefaultValue( 'status', arg, 1 ) ).toBe( 'draft' );
		expect( generateDefaultValue( 'status', arg, 2 ) ).toBe( 'draft' );
	} );

	it( 'stringifies a non-string default', () => {
		const arg: EndpointArgSchema = { type: 'integer', default: 10 };
		expect( generateDefaultValue( 'per_page', arg, 1 ) ).toBe( '10' );
	} );

	it( 'falls back to the first enum value when there is no default, regardless of index', () => {
		const arg: EndpointArgSchema = {
			type: 'string',
			enum: [ 'view', 'edit', 'embed' ],
		};
		expect( generateDefaultValue( 'context', arg, 1 ) ).toBe( 'view' );
		expect( generateDefaultValue( 'context', arg, 2 ) ).toBe( 'view' );
	} );

	it( 'synthesizes a unique-per-item email for a string+email field', () => {
		const arg: EndpointArgSchema = { type: 'string', format: 'email' };
		expect( generateDefaultValue( 'email', arg, 1 ) ).toBe(
			'generated-1@example.com'
		);
		expect( generateDefaultValue( 'email', arg, 2 ) ).toBe(
			'generated-2@example.com'
		);
	} );

	it.each( [ 'uri', 'url' ] )(
		'synthesizes a unique-per-item URL for a string+%s field',
		( format ) => {
			const arg: EndpointArgSchema = { type: 'string', format };
			expect( generateDefaultValue( 'link', arg, 1 ) ).toBe(
				'https://example.com/generated-1'
			);
		}
	);

	it( 'synthesizes a unique-per-item ISO timestamp for a string+date-time field, rolling over months correctly', () => {
		const arg: EndpointArgSchema = { type: 'string', format: 'date-time' };
		expect( generateDefaultValue( 'published', arg, 1 ) ).toBe(
			'2020-01-01T00:00:00.000Z'
		);
		expect( generateDefaultValue( 'published', arg, 32 ) ).toBe(
			'2020-02-01T00:00:00.000Z'
		);
	} );

	it( 'synthesizes a unique-per-item uuid for a string+uuid field', () => {
		const arg: EndpointArgSchema = { type: 'string', format: 'uuid' };
		expect( generateDefaultValue( 'uuid', arg, 1 ) ).toBe(
			'00000000-0000-4000-8000-000000000001'
		);
		expect( generateDefaultValue( 'uuid', arg, 2 ) ).toBe(
			'00000000-0000-4000-8000-000000000002'
		);
	} );

	it( 'synthesizes a unique-per-item IP for a string+ip field, wrapping octets correctly', () => {
		const arg: EndpointArgSchema = { type: 'string', format: 'ip' };
		expect( generateDefaultValue( 'ip', arg, 1 ) ).toBe( '10.0.0.1' );
		expect( generateDefaultValue( 'ip', arg, 300 ) ).toBe( '10.0.1.44' );
	} );

	it( 'synthesizes a unique-per-item hex color for a string+hex-color field', () => {
		const arg: EndpointArgSchema = { type: 'string', format: 'hex-color' };
		expect( generateDefaultValue( 'color', arg, 1 ) ).toBe( '#000001' );
	} );

	it( 'synthesizes a readable placeholder for a plain string field with no format', () => {
		const arg: EndpointArgSchema = { type: 'string' };
		expect( generateDefaultValue( 'title', arg, 1 ) ).toBe(
			'Generated title 1'
		);
		expect( generateDefaultValue( 'name', arg, 2 ) ).toBe(
			'Generated name 2'
		);
	} );

	it( 'synthesizes an increasing integer, defaulting the floor to 1', () => {
		const arg: EndpointArgSchema = { type: 'integer' };
		expect( generateDefaultValue( 'age', arg, 1 ) ).toBe( '1' );
		expect( generateDefaultValue( 'age', arg, 2 ) ).toBe( '2' );
	} );

	it( 'respects a declared minimum for integer/number fields', () => {
		const arg: EndpointArgSchema = { type: 'integer', minimum: 100 };
		expect( generateDefaultValue( 'age', arg, 1 ) ).toBe( '100' );
		expect( generateDefaultValue( 'age', arg, 2 ) ).toBe( '101' );
	} );

	it( 'clamps to a declared maximum for integer/number fields', () => {
		const arg: EndpointArgSchema = {
			type: 'integer',
			minimum: 1,
			maximum: 1,
		};
		expect( generateDefaultValue( 'age', arg, 1 ) ).toBe( '1' );
		expect( generateDefaultValue( 'age', arg, 2 ) ).toBe( '1' );
	} );

	it( 'synthesizes a fractional number without truncating', () => {
		const arg: EndpointArgSchema = { type: 'number', minimum: 0.5 };
		expect( generateDefaultValue( 'price', arg, 1 ) ).toBe( '0.5' );
		expect( generateDefaultValue( 'price', arg, 2 ) ).toBe( '1.5' );
	} );

	it( 'synthesizes a fixed boolean, regardless of index', () => {
		const arg: EndpointArgSchema = { type: 'boolean' };
		expect( generateDefaultValue( 'sticky', arg, 1 ) ).toBe( 'true' );
		expect( generateDefaultValue( 'sticky', arg, 2 ) ).toBe( 'true' );
	} );

	it( 'synthesizes an empty JSON array for an array field', () => {
		const arg: EndpointArgSchema = { type: 'array' };
		expect( generateDefaultValue( 'tags', arg, 1 ) ).toBe( '[]' );
	} );

	it( 'synthesizes an empty JSON object for an object field', () => {
		const arg: EndpointArgSchema = { type: 'object' };
		expect( generateDefaultValue( 'meta', arg, 1 ) ).toBe( '{}' );
	} );

	it( 'picks the first non-null type when type is an array', () => {
		const arg: EndpointArgSchema = { type: [ 'string', 'null' ] };
		expect( generateDefaultValue( 'excerpt', arg, 1 ) ).toBe(
			'Generated excerpt 1'
		);
	} );

	it( 'falls back to the plain-string placeholder when there is no type at all', () => {
		const arg: EndpointArgSchema = {};
		expect( generateDefaultValue( 'anything', arg, 1 ) ).toBe(
			'Generated anything 1'
		);
	} );
} );
