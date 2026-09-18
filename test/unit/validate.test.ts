/**
 * External dependencies
 */
import { describe, expect, it } from '@jest/globals';

/**
 * Internal dependencies
 */
import { CliError } from '../../src/core/errors.js';
import {
	coerceJsonFields,
	validateFieldTypes,
} from '../../src/core/validate.js';
import type { EndpointArgSchema } from '../../src/types.js';

const args: Record< string, EndpointArgSchema > = {
	per_page: { type: 'integer' },
	price: { type: 'number' },
	sticky: { type: 'boolean' },
	title: { type: 'string' },
	status: { type: [ 'string', 'null' ] },
	meta: { type: 'object' },
	tags: { type: 'array' },
	untyped: {},
};

describe( 'validateFieldTypes', () => {
	it( 'does nothing when there is no arg schema to check against', () => {
		expect( () =>
			validateFieldTypes( { anything: 'goes' }, undefined )
		).not.toThrow();
	} );

	it( 'passes valid values through without throwing', () => {
		expect( () =>
			validateFieldTypes(
				{
					per_page: '5',
					price: '3.14',
					sticky: 'true',
					title: 'Hello world',
					status: 'draft',
					meta: '{}',
					tags: 'a,b',
				},
				args
			)
		).not.toThrow();
	} );

	it( 'ignores fields with no matching arg in the schema', () => {
		expect( () =>
			validateFieldTypes( { unknown_field: 'whatever' }, args )
		).not.toThrow();
	} );

	it( 'ignores fields with no declared type', () => {
		expect( () =>
			validateFieldTypes( { untyped: 'whatever' }, args )
		).not.toThrow();
	} );

	it( 'rejects a non-integer value for an integer arg', () => {
		expect( () => validateFieldTypes( { per_page: 'abc' }, args ) ).toThrow(
			CliError
		);
		expect( () => validateFieldTypes( { per_page: 'abc' }, args ) ).toThrow(
			'--per_page must be of type integer, got "abc".'
		);
	} );

	it( 'rejects a non-numeric value for a number arg', () => {
		expect( () => validateFieldTypes( { price: 'free' }, args ) ).toThrow(
			'--price must be of type number, got "free".'
		);
	} );

	it( 'rejects a non-boolean-like value for a boolean arg', () => {
		expect( () => validateFieldTypes( { sticky: 'yep' }, args ) ).toThrow(
			'--sticky must be of type boolean, got "yep".'
		);
	} );

	it( 'accepts a value matching any type in a union', () => {
		expect( () =>
			validateFieldTypes( { status: 'draft' }, args )
		).not.toThrow();
	} );

	it( 'reports every mismatched field at once', () => {
		try {
			validateFieldTypes( { per_page: 'abc', price: 'free' }, args );
			throw new Error( 'expected validateFieldTypes to throw' );
		} catch ( error ) {
			expect( error ).toBeInstanceOf( CliError );
			expect( ( error as CliError ).message ).toContain( '--per_page' );
			expect( ( error as CliError ).message ).toContain( '--price' );
		}
	} );

	describe( 'checkRequired', () => {
		const requiredArgs: Record< string, EndpointArgSchema > = {
			title: { type: 'string', required: true },
			status: { type: 'string', required: false },
		};

		it( 'does not check for missing required fields by default', () => {
			expect( () =>
				validateFieldTypes( {}, requiredArgs )
			).not.toThrow();
		} );

		it( 'rejects a missing required field when checkRequired is set', () => {
			expect( () =>
				validateFieldTypes( {}, requiredArgs, true )
			).toThrow( '--title is required.' );
		} );

		it( 'passes when the required field is present', () => {
			expect( () =>
				validateFieldTypes( { title: 'Hello' }, requiredArgs, true )
			).not.toThrow();
		} );

		it( 'does not require an optional field', () => {
			expect( () =>
				validateFieldTypes( { title: 'Hello' }, requiredArgs, true )
			).not.toThrow();
		} );

		it( 'reports a missing required field alongside a type mismatch', () => {
			try {
				validateFieldTypes(
					{ per_page: 'abc' },
					{ ...requiredArgs, per_page: { type: 'integer' } },
					true
				);
				throw new Error( 'expected validateFieldTypes to throw' );
			} catch ( error ) {
				expect( error ).toBeInstanceOf( CliError );
				expect( ( error as CliError ).message ).toContain(
					'--title is required.'
				);
				expect( ( error as CliError ).message ).toContain(
					'--per_page must be of type integer'
				);
			}
		} );
	} );
} );

describe( 'coerceJsonFields', () => {
	it( 'returns fields unchanged when there is no arg schema', () => {
		expect( coerceJsonFields( { meta: '{"a":1}' }, undefined ) ).toEqual( {
			meta: '{"a":1}',
		} );
	} );

	it( 'JSON-parses an object-typed field whose value is valid JSON', () => {
		expect( coerceJsonFields( { meta: '{"color":"red"}' }, args ) ).toEqual(
			{ meta: { color: 'red' } }
		);
	} );

	it( 'JSON-parses an array-typed field whose value is valid JSON', () => {
		expect( coerceJsonFields( { tags: '[1,2,3]' }, args ) ).toEqual( {
			tags: [ 1, 2, 3 ],
		} );
	} );

	it( 'leaves an object-typed field as the raw string when it is not valid JSON', () => {
		expect( coerceJsonFields( { meta: 'not json' }, args ) ).toEqual( {
			meta: 'not json',
		} );
	} );

	it( 'never touches a string-typed field, even if it looks like JSON', () => {
		expect(
			coerceJsonFields( { title: '{"looks":"like json"}' }, args )
		).toEqual( { title: '{"looks":"like json"}' } );
	} );

	it( 'leaves fields with no matching or untyped arg untouched', () => {
		expect(
			coerceJsonFields(
				{ unknown_field: 'whatever', untyped: 'whatever' },
				args
			)
		).toEqual( { unknown_field: 'whatever', untyped: 'whatever' } );
	} );
} );
