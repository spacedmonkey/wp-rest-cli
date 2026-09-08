import { inspect } from 'node:util';
import { table as renderTable, getBorderCharacters } from 'table';
import { flatten } from 'flat';
import { stringify as stringifyYaml } from 'yaml';
import { json2csv } from 'json-2-csv';
import pc from 'picocolors';
import { CliError } from './errors.js';
import type { OutputFormat } from '../types.js';

export interface FormatOptions {
	format: OutputFormat;
	fields?: string;
	field?: string;
	color: boolean;
}

/**
 * Reads a dot-separated key path out of a nested object, for `--field`.
 * @param row  The object to read from.
 * @param path A dot-separated key path (e.g. `meta.foo`).
 * @return The value at `path`, or undefined if any segment is missing.
 */
function getByPath( row: Record< string, unknown >, path: string ): unknown {
	return path.split( '.' ).reduce< unknown >( ( acc, key ) => {
		if ( acc && typeof acc === 'object' ) {
			return ( acc as Record< string, unknown > )[ key ];
		}
		return undefined;
	}, row );
}

/**
 * Normalizes a response body to an array of row objects, whether the API
 * returned a collection, a single item, or something un-iterable.
 * @param data The raw response body.
 * @return `data` as an array of objects.
 */
function asArray( data: unknown ): Record< string, unknown >[] {
	if ( Array.isArray( data ) ) {
		return data as Record< string, unknown >[];
	}
	if ( data && typeof data === 'object' ) {
		return [ data as Record< string, unknown > ];
	}
	return [];
}

/**
 * Dot-flattens a row and, if `--fields` was given, picks just those flattened
 * keys — used for table/csv output, whose columns must be flat.
 * @param row    The row to flatten and filter.
 * @param fields The `--fields` list, or undefined to keep every column.
 * @return The flattened (and possibly filtered) row.
 */
function selectFields(
	row: Record< string, unknown >,
	fields: string[] | undefined
): Record< string, unknown > {
	const flat = flatten<
		Record< string, unknown >,
		Record< string, unknown >
	>( row, { safe: true } );
	if ( ! fields || fields.length === 0 ) {
		return flat;
	}
	const picked: Record< string, unknown > = {};
	for ( const key of fields ) {
		picked[ key ] = flat[ key ];
	}
	return picked;
}

/**
 * The `table` package rejects cell strings containing certain control characters
 * (tabs, carriage returns, etc.) - WP fields like content/excerpt HTML routinely
 * contain these, so strip them for table output (other formats keep raw values).
 * Newlines (code point 10) are left intact since `table` renders multi-line cells fine.
 * @param value The raw cell string.
 * @return `value` with disallowed control characters removed.
 */
function sanitizeForTable( value: string ): string {
	return Array.from( value.replace( /\r\n?/g, '\n' ) )
		.filter( ( char ) => {
			const code = char.codePointAt( 0 ) ?? 0;
			return code === 10 || code >= 32;
		} )
		.join( '' );
}

/**
 * Renders a single table cell value as sanitized text.
 * @param value The raw field value.
 * @return The cell's display string.
 */
function stringifyCell( value: unknown ): string {
	if ( value === undefined ) {
		return '';
	}
	if ( value === null ) {
		return 'null';
	}
	if ( typeof value === 'string' ) {
		return sanitizeForTable( value );
	}
	return sanitizeForTable( JSON.stringify( value ) );
}

/**
 * Picks top-level keys only, preserving nested structure (unlike selectFields' dot-flattening used for table/csv columns).
 * @param row    The row to filter.
 * @param fields The top-level keys to keep.
 * @return A copy of `row` containing only `fields`.
 */
function pickTopLevel(
	row: Record< string, unknown >,
	fields: string[]
): Record< string, unknown > {
	const picked: Record< string, unknown > = {};
	for ( const key of fields ) {
		picked[ key ] = row[ key ];
	}
	return picked;
}

/**
 * Applies --fields to json/yaml/raw output while preserving the original array-vs-object shape.
 * @param data   The response body (an array, an object, or a scalar).
 * @param fields The `--fields` list, or undefined to leave `data` untouched.
 * @return `data` filtered to `fields`, in its original shape.
 */
function applyTopLevelFields(
	data: unknown,
	fields: string[] | undefined
): unknown {
	if ( ! fields ) {
		return data;
	}
	if ( Array.isArray( data ) ) {
		return data.map( ( row ) =>
			row && typeof row === 'object'
				? pickTopLevel( row as Record< string, unknown >, fields )
				: row
		);
	}
	if ( data && typeof data === 'object' ) {
		return pickTopLevel( data as Record< string, unknown >, fields );
	}
	return data;
}

/**
 * Renders a REST API response body per `--format` (table/json/csv/yaml/ids/count/raw),
 * applying `--fields`/`--field` selection along the way.
 * @param data    The parsed response body to render.
 * @param options Output format, field selection, and color settings.
 * @return The rendered output string.
 */
export async function formatOutput(
	data: unknown,
	options: FormatOptions
): Promise< string > {
	const fields = options.fields
		? options.fields
				.split( ',' )
				.map( ( f ) => f.trim() )
				.filter( Boolean )
		: undefined;

	if ( options.field ) {
		const rows = asArray( data );
		const values = rows.map( ( row ) =>
			getByPath( row, options.field as string )
		);
		const result = Array.isArray( data ) ? values : values[ 0 ];
		return typeof result === 'string'
			? result
			: JSON.stringify( result, null, 2 );
	}

	switch ( options.format ) {
		case 'json':
			return JSON.stringify(
				applyTopLevelFields( data, fields ),
				null,
				2
			);

		case 'yaml':
			return stringifyYaml( applyTopLevelFields( data, fields ) );

		case 'raw':
			return inspect( applyTopLevelFields( data, fields ), {
				colors: options.color,
				depth: null,
				compact: false,
			} );

		case 'ids': {
			const rows = asArray( data );
			return rows.map( ( row ) => row.id ).join( ' ' );
		}

		case 'count': {
			const rows = asArray( data );
			return String( rows.length );
		}

		case 'csv': {
			const rows = asArray( data ).map( ( row ) =>
				selectFields( row, fields )
			);
			if ( rows.length === 0 ) {
				return '';
			}
			// Keys are already flattened via selectFields (using `flat`), so tell
			// json-2-csv not to re-escape the literal dots in those header names.
			return await json2csv( rows, {
				escapeHeaderNestedDots: false,
				expandNestedObjects: false,
			} );
		}

		case 'table': {
			const rows = asArray( data ).map( ( row ) =>
				selectFields( row, fields )
			);
			if ( rows.length === 0 ) {
				return options.color ? pc.dim( 'No results.' ) : 'No results.';
			}
			const columns = fields ?? [
				...new Set( rows.flatMap( ( row ) => Object.keys( row ) ) ),
			];
			const header = options.color
				? columns.map( ( c ) => pc.bold( c ) )
				: columns;
			const body = rows.map( ( row ) =>
				columns.map( ( c ) => stringifyCell( row[ c ] ) )
			);
			// WP-CLI's own tables use a plain ASCII +/-/| border with rules only
			// around the header (not between every data row) — match that look
			// instead of the `table` package's default Unicode box-drawing style.
			// `ramac`'s mid-table join line uses "|" at the corners (meant for a
			// separator between data rows); override it to "+" to match the
			// header-separator look WP-CLI actually uses.
			return renderTable( [ header, ...body ], {
				border: {
					...getBorderCharacters( 'ramac' ),
					joinLeft: '+',
					joinRight: '+',
					joinJoin: '+',
				},
				drawHorizontalLine: ( index, size ) =>
					index === 0 || index === 1 || index === size,
			} );
		}

		default:
			throw new CliError(
				`Unknown --format value: ${ String( options.format ) }`
			);
	}
}
