/**
 * Internal dependencies
 */
import { CliError } from './errors.js';
import type { EndpointArgSchema } from '../types.js';

/**
 * String values WordPress's own `rest_sanitize_boolean()` treats as boolean-ish,
 * so a `--field=value` matching one of these is accepted for a `boolean` arg.
 */
const BOOLEAN_LIKE = new Set( [
	'1',
	'true',
	'yes',
	'on',
	'0',
	'false',
	'no',
	'off',
	'',
] );

/**
 * Whether a raw CLI string satisfies one declared JSON Schema primitive type.
 * `array`/`object`/`null` are treated as always satisfied — a bare
 * `field=value` token has no syntax for them, so there's nothing meaningful
 * to check client-side; the API itself still validates the eventual body.
 * @param value The raw string value from a `field=value` token.
 * @param type  One JSON Schema type name from the route's arg schema.
 * @return Whether `value` looks like a valid `type`.
 */
function matchesType( value: string, type: string ): boolean {
	switch ( type ) {
		case 'integer':
			return /^-?\d+$/.test( value.trim() );
		case 'number':
			return value.trim() !== '' && ! Number.isNaN( Number( value ) );
		case 'boolean':
			return BOOLEAN_LIKE.has( value.trim().toLowerCase() );
		case 'string':
		case 'array':
		case 'object':
		case 'null':
		default:
			return true;
	}
}

/**
 * Validates `field=value` CLI arguments against a route's declared arg
 * schema (as introspected via OPTIONS), catching type mismatches locally
 * — e.g. `--per_page=abc` when the schema declares `per_page` as `integer`
 * — before they're ever sent to the API.
 * @param  fields The parsed `field=value` arguments.
 * @param  args   The matching endpoint's argument schema, if any.
 * @throws {CliError} Listing every field whose value doesn't match its declared type.
 */
export function validateFieldTypes(
	fields: Record< string, string >,
	args: Record< string, EndpointArgSchema > | undefined
): void {
	if ( ! args ) {
		return;
	}
	const problems: string[] = [];
	for ( const [ name, value ] of Object.entries( fields ) ) {
		const arg = args[ name ];
		if ( ! arg?.type ) {
			continue;
		}
		const types = Array.isArray( arg.type ) ? arg.type : [ arg.type ];
		if ( ! types.some( ( type ) => matchesType( value, type ) ) ) {
			problems.push(
				`--${ name } must be of type ${ types.join(
					'|'
				) }, got "${ value }".`
			);
		}
	}
	if ( problems.length ) {
		throw new CliError( problems.join( '\n' ) );
	}
}
