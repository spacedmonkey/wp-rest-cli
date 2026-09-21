/**
 * External dependencies
 */
import { describe, expect, it } from '@jest/globals';

/**
 * Internal dependencies
 */
import {
	parseErrorResponse,
	formatErrorForDisplay,
	formatErrorForJson,
	WpApiError,
	CliError,
} from '../../src/core/errors.js';

describe( 'parseErrorResponse', () => {
	it( 'parses a well-formed WP REST API error body into a WpApiError', async () => {
		const response = new Response(
			JSON.stringify( {
				code: 'rest_post_invalid_id',
				message: 'Invalid post ID.',
				data: { status: 404 },
			} ),
			{ status: 404 }
		);
		const error = await parseErrorResponse( response );
		expect( error ).toBeInstanceOf( WpApiError );
		const wpError = error as WpApiError;
		expect( wpError.code ).toBe( 'rest_post_invalid_id' );
		expect( wpError.status ).toBe( 404 );
		expect( wpError.message ).toBe( 'Invalid post ID.' );
	} );

	it( 'falls back to a CliError for a non-JSON error body', async () => {
		const response = new Response( '<html>Internal Server Error</html>', {
			status: 500,
		} );
		const error = await parseErrorResponse( response );
		expect( error ).toBeInstanceOf( CliError );
	} );

	it( 'explains a 413 without dumping the HTML page', async () => {
		const response = new Response(
			'<html><head><title>413 Request Entity Too Large</title></head></html>',
			{ status: 413 }
		);
		const error = await parseErrorResponse( response );
		expect( error ).toBeInstanceOf( CliError );
		expect( error.message ).toMatch( /too large \(HTTP 413\)/ );
		expect( error.message ).not.toContain( '<html>' );
	} );

	it( 'strips tags from other HTML error bodies', async () => {
		const response = new Response(
			'<html><body><h1>Bad Gateway</h1></body></html>',
			{ status: 502 }
		);
		const error = await parseErrorResponse( response );
		expect( error.message ).toBe(
			'Request failed with status 502: Bad Gateway'
		);
	} );

	it( 'keeps response headers on the error', async () => {
		const response = new Response(
			JSON.stringify( { code: 'x', message: 'y' } ),
			{ status: 500, headers: { 'x-wp-upload-attachment-id': '77' } }
		);
		const error = await parseErrorResponse( response );
		expect( error.headers?.get( 'x-wp-upload-attachment-id' ) ).toBe(
			'77'
		);
	} );
} );

describe( 'formatErrorForDisplay', () => {
	it( 'appends a hint to upload errors', () => {
		const error = new WpApiError(
			{ code: 'rest_upload_no_data', message: 'No data supplied.' },
			400
		);
		expect( formatErrorForDisplay( error ) ).toMatch(
			/rest_upload_no_data, status 400\)\n.*post_max_size/
		);
	} );

	it( 'formats a WpApiError with its code and status', () => {
		const error = new WpApiError(
			{ code: 'rest_forbidden', message: 'Not allowed.' },
			401
		);
		expect( formatErrorForDisplay( error ) ).toBe(
			'Error: Not allowed. (rest_forbidden, status 401)\nNot allowed: check credentials (see `wp auth ... status`) and that the user has the needed capability.'
		);
	} );

	it( 'formats a CliError with just its message', () => {
		expect(
			formatErrorForDisplay( new CliError( 'Missing --url.' ) )
		).toBe( 'Error: Missing --url.' );
	} );
} );

describe( 'formatErrorForJson', () => {
	it( 'includes code, status and a hint for a WpApiError', () => {
		const error = new WpApiError(
			{
				code: 'rest_forbidden',
				message: 'Not allowed.',
				data: { status: 401 },
			},
			401
		);
		const parsed = JSON.parse( formatErrorForJson( error ) );
		expect( parsed.error ).toMatchObject( {
			code: 'rest_forbidden',
			status: 401,
			message: 'Not allowed.',
		} );
		expect( parsed.error.hint ).toEqual( expect.any( String ) );
	} );

	it( 'carries only a message for a local error', () => {
		expect(
			JSON.parse( formatErrorForJson( new CliError( 'bad' ) ) )
		).toEqual( { error: { message: 'bad' } } );
	} );
} );
