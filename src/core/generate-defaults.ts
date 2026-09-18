/**
 * Internal dependencies
 */
import type { EndpointArgSchema } from '../types.js';

/**
 * A day offset from a fixed epoch, used for the `date-time` format branch —
 * deliberately not "now": every synthesized value in this module is a pure
 * function of `index` (no wall-clock time, no randomness) so `generate`'s
 * output stays reproducible across runs and assertable exactly in tests.
 */
const DATE_TIME_EPOCH_YEAR = 2020;

/**
 * Resolves an arg's primary JSON Schema type for synthesis purposes: when
 * `type` is an array (e.g. `['string', 'null']`), the first non-`'null'`
 * entry is used, since `'null'` alone carries no synthesizable shape.
 * @param arg The field's live JSON Schema.
 * @return The primary type name to synthesize a value for.
 */
function resolvePrimaryType( arg: EndpointArgSchema ): string {
	let types: string[];
	if ( Array.isArray( arg.type ) ) {
		types = arg.type;
	} else {
		types = arg.type ? [ arg.type ] : [];
	}
	return types.find( ( type ) => type !== 'null' ) ?? 'string';
}

/**
 * Whether an `object`-typed arg is WordPress core's `{raw, rendered}` shape
 * for a rich-text field (`title`/`content`/`excerpt`) rather than a genuine
 * structured object (like `meta`) — recognized by a `raw` property declared
 * `string`. WordPress's own controllers for these fields accept a plain
 * string directly in place of the full object (see `coerceJsonFields` in
 * `core/validate.ts`, which leaves a non-JSON string value as-is for this
 * exact reason), so synthesizing `'{}'` for one — while valid JSON — is
 * still an *empty* title/content as far as WordPress is concerned.
 * @param arg The field's live JSON Schema.
 * @return Whether a plain string, not `'{}'`, is the right synthesized value.
 */
function isRawRenderedShape( arg: EndpointArgSchema ): boolean {
	const rawProperty = arg.properties?.raw;
	if ( ! rawProperty ) {
		return false;
	}
	const rawTypes = Array.isArray( rawProperty.type )
		? rawProperty.type
		: [ rawProperty.type ];
	return rawTypes.includes( 'string' );
}

/**
 * Field names WordPress treats as a login/slug-style identifier rather than
 * free text — `username`/`slug`'s own live schema (like `title`/`content`
 * above) gives no hint of this at all: no `pattern`, no `format`, nothing
 * beyond `{type: 'string', required: true}` — the actual constraint lives
 * in WordPress's own `validate_username()`/`sanitize_title()`, invisible to
 * introspection. A generic `Generated ${name} ${index}` placeholder (with
 * its spaces and capital letters) is liable to be rejected — real WP-CLI's
 * own `wp user generate` likewise never uses freeform text for a username —
 * so these get a lowercase, hyphenated, space-free placeholder instead.
 */
const IDENTIFIER_FIELD_NAMES: Record< string, string > = {
	username: 'generated-user',
	user_login: 'generated-user',
	slug: 'generated-slug',
	user_nicename: 'generated-slug',
	nicename: 'generated-slug',
};

/**
 * Reads a numeric schema constraint (`minimum`/`maximum`) off an arg. These
 * aren't named fields on `EndpointArgSchema` — only reachable through its
 * index signature — so this narrows the `unknown` value safely.
 * @param arg  The field's live JSON Schema.
 * @param name The constraint's key, e.g. `'minimum'`.
 * @return The constraint's numeric value, or undefined if absent/non-numeric.
 */
function readNumericConstraint(
	arg: EndpointArgSchema,
	name: string
): number | undefined {
	const value = arg[ name ];
	return typeof value === 'number' ? value : undefined;
}

/**
 * Synthesizes a numeric string for an `integer`/`number` arg: starts at the
 * arg's declared `minimum` (default `1`) and increases by one per `index`,
 * clamped to `maximum` when declared — deterministic and unique per index
 * except where the `minimum`/`maximum` range is narrower than the batch.
 * @param arg      The field's live JSON Schema.
 * @param index    The 1-based position of the item being generated.
 * @param truncate Whether to round down to a whole number (for `integer`).
 * @return The synthesized numeric value, as a string.
 */
function generateNumericValue(
	arg: EndpointArgSchema,
	index: number,
	truncate: boolean
): string {
	const min = readNumericConstraint( arg, 'minimum' ) ?? 1;
	const max = readNumericConstraint( arg, 'maximum' );
	let value = min + ( index - 1 );
	if ( typeof max === 'number' && value > max ) {
		value = max;
	}
	return String( truncate ? Math.trunc( value ) : value );
}

/**
 * Synthesizes a placeholder value for a `generate`-verb field whose schema
 * marks it `required` but the CLI invocation didn't supply — so `generate`
 * can still create items in bulk without the user having to know and type
 * every required field for every route by hand. Derived from the field's
 * live JSON Schema (`type`/`format`, or `default`/`enum` when declared)
 * combined with the item's position in the current `--count` batch, so
 * values are both plausible for the declared type/format and unique across
 * a multi-item batch (important for fields a site requires to be unique,
 * like an email address) — without any real randomness, so the same
 * `(arg, index)` pair always produces the same value.
 * @param name  The field's name, used in the plain-string fallback placeholder.
 * @param arg   The field's live JSON Schema, as returned by the route's OPTIONS response.
 * @param index The 1-based position of the item being generated in the current `generate --count` loop.
 * @return A string value, compatible with the same `field=value` pipeline a
 *         user-typed CLI token goes through — including `coerceJsonFields`
 *         later JSON-parsing an `object`/`array`-typed result.
 */
export function generateDefaultValue(
	name: string,
	arg: EndpointArgSchema,
	index: number
): string {
	if ( arg.default !== undefined ) {
		const { default: defaultValue } = arg;
		return typeof defaultValue === 'string'
			? defaultValue
			: JSON.stringify( defaultValue );
	}
	if ( arg.enum && arg.enum.length ) {
		return String( arg.enum[ 0 ] );
	}

	const type = resolvePrimaryType( arg );
	switch ( type ) {
		case 'integer':
			return generateNumericValue( arg, index, true );
		case 'number':
			return generateNumericValue( arg, index, false );
		case 'boolean':
			return 'true';
		case 'array':
			return '[]';
		case 'object':
			return isRawRenderedShape( arg )
				? `Generated ${ name } ${ index }`
				: '{}';
		case 'string':
		default: {
			const identifierPrefix = IDENTIFIER_FIELD_NAMES[ name ];
			if ( identifierPrefix ) {
				return `${ identifierPrefix }-${ index }`;
			}
			switch ( arg.format ) {
				case 'email':
					return `generated-${ index }@example.com`;
				case 'uri':
				case 'url':
					return `https://example.com/generated-${ index }`;
				case 'date-time':
					return new Date(
						Date.UTC( DATE_TIME_EPOCH_YEAR, 0, index )
					).toISOString();
				case 'uuid':
					return `00000000-0000-4000-8000-${ String( index ).padStart(
						12,
						'0'
					) }`;
				case 'ip':
					return `10.0.${ Math.floor( index / 256 ) % 256 }.${
						index % 256
					}`;
				case 'hex-color':
					return `#${ ( index % 0xffffff )
						.toString( 16 )
						.padStart( 6, '0' ) }`;
				default:
					return `Generated ${ name } ${ index }`;
			}
		}
	}
}
