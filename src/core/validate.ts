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
 * schema (as introspected via OPTIONS), catching problems locally before
 * they're ever sent to the API: a value whose type doesn't match its
 * declared schema type (e.g. `--per_page=abc` when `per_page` is `integer`),
 * and — when `checkRequired` is set — any `required` arg missing from
 * `fields` altogether.
 * @param  fields        The parsed `field=value` arguments.
 * @param  args          The matching endpoint's argument schema, if any.
 * @param  checkRequired Whether to also flag the endpoint's `required` args
 *                       that `fields` doesn't set at all. Only meaningful
 *                       for a verb whose schema reflects the *full* set of
 *                       fields the request must carry (`create`/`generate`)
 *                       — a schema borrowed for `update`, say, still lists
 *                       create-time required fields that a partial update
 *                       legitimately omits, so callers must opt in per verb.
 * @throws {CliError} Listing every missing-required and type-mismatched field at once.
 */
export function validateFieldTypes(
	fields: Record< string, string >,
	args: Record< string, EndpointArgSchema > | undefined,
	checkRequired = false
): void {
	if ( ! args ) {
		return;
	}
	const problems: string[] = [];
	if ( checkRequired ) {
		for ( const [ name, arg ] of Object.entries( args ) ) {
			if ( arg?.required && ! ( name in fields ) ) {
				problems.push( `--${ name } is required.` );
			}
		}
	}
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

/**
 * JSON-parses a `field=value` argument's raw string value when the route's
 * live schema declares that field `object`/`array`-typed (e.g. `meta`), so a
 * structured value like `--meta={"key":"value"}` is sent as real JSON rather
 * than a literal string the API would reject or silently ignore. WordPress's
 * own REST controllers for `content`/`title`/`excerpt` (declared `object` in
 * schema, for their `{raw,rendered,protected}` shape) also accept a plain
 * string directly, so a value that isn't valid JSON is left as-is rather
 * than rejected here — the API is the final authority on whether the string
 * is acceptable for that field.
 * @param fields The parsed `field=value` arguments.
 * @param args   The matching endpoint's argument schema, if any.
 * @return A copy of `fields` with object/array-typed values JSON-parsed
 *         where the raw value is valid JSON; everything else is left as the
 *         original string.
 */
export function coerceJsonFields(
	fields: Record< string, string >,
	args: Record< string, EndpointArgSchema > | undefined
): Record< string, unknown > {
	if ( ! args ) {
		return fields;
	}
	const result: Record< string, unknown > = { ...fields };
	for ( const [ name, value ] of Object.entries( fields ) ) {
		const arg = args[ name ];
		if ( ! arg?.type ) {
			continue;
		}
		const types = Array.isArray( arg.type ) ? arg.type : [ arg.type ];
		if (
			! types.some( ( type ) => type === 'object' || type === 'array' )
		) {
			continue;
		}
		try {
			result[ name ] = JSON.parse( value );
		} catch {
			// Not valid JSON — leave the raw string.
		}
	}
	return result;
}

/**
 * Levenshtein distance between two short strings.
 * @param a First string.
 * @param b Second string.
 * @return The minimum number of single-character edits turning `a` into `b`.
 */
function editDistance( a: string, b: string ): number {
	let previous = Array.from( { length: b.length + 1 }, ( _, i ) => i );
	for ( let i = 1; i <= a.length; i++ ) {
		const current = [ i ];
		for ( let j = 1; j <= b.length; j++ ) {
			current[ j ] = Math.min(
				( previous[ j ] as number ) + 1,
				( current[ j - 1 ] as number ) + 1,
				( previous[ j - 1 ] as number ) +
					( a[ i - 1 ] === b[ j - 1 ] ? 0 : 1 )
			);
		}
		previous = current;
	}
	return previous[ b.length ] as number;
}

/**
 * Warnings for `field=value` names the route's live schema doesn't declare
 * (typos like `--per-page` are otherwise forwarded to the API and ignored).
 * Names starting with `_` (e.g. `_embed`) are WordPress-wide and never flagged.
 * @param fields Parsed `field=value` arguments.
 * @param args   The endpoint's declared args, if known.
 * @return One human-readable warning per unknown field, with a suggestion when close.
 */
export function unknownFieldWarnings(
	fields: Record< string, unknown >,
	args: Record< string, EndpointArgSchema > | undefined
): string[] {
	if ( ! args ) {
		return [];
	}
	const known = Object.keys( args );
	return Object.keys( fields )
		.filter(
			( name ) =>
				! name.startsWith( '_' ) && ! Object.hasOwn( args, name )
		)
		.map( ( name ) => {
			const limit = Math.max( 1, Math.floor( name.length / 3 ) );
			const guess = known
				.map( ( arg ) => ( {
					arg,
					distance:
						arg === name.replace( /-/g, '_' )
							? 0
							: editDistance( arg, name ),
				} ) )
				.filter( ( { distance } ) => distance <= limit )
				.sort( ( a, b ) => a.distance - b.distance )[ 0 ]?.arg;
			return `Warning: --${ name } is not a declared arg of this route${
				guess ? `; did you mean --${ guess }?` : ''
			}`;
		} );
}
