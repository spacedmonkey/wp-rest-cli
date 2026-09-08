import { describe, expect, it } from '@jest/globals';
import {
	parseErrorResponse,
	formatErrorForDisplay,
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
} );

describe( 'formatErrorForDisplay', () => {
	it( 'formats a WpApiError with its code and status', () => {
		const error = new WpApiError(
			{ code: 'rest_forbidden', message: 'Not allowed.' },
			401
		);
		expect( formatErrorForDisplay( error ) ).toBe(
			'Error: Not allowed. (rest_forbidden, status 401)'
		);
	} );

	it( 'formats a CliError with just its message', () => {
		expect(
			formatErrorForDisplay( new CliError( 'Missing --url.' ) )
		).toBe( 'Error: Missing --url.' );
	} );
} );
