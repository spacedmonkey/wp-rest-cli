import { describe, expect, it } from '@jest/globals';
import { parseCommandArgs } from '../../src/commands/rest.js';
import { CliError } from '../../src/core/errors.js';

describe( 'parseCommandArgs', () => {
	it( 'parses no args as the namespaces mode', () => {
		expect( parseCommandArgs( [] ) ).toEqual( { mode: 'namespaces' } );
	} );

	it( 'parses a single arg as the routes mode', () => {
		expect( parseCommandArgs( [ 'wp/v2' ] ) ).toEqual( {
			mode: 'routes',
			namespace: 'wp/v2',
		} );
	} );

	it( 'parses namespace + route with no verb as the introspect mode', () => {
		expect( parseCommandArgs( [ 'wp/v2', 'posts' ] ) ).toEqual( {
			mode: 'introspect',
			namespace: 'wp/v2',
			route: 'posts',
		} );
	} );

	it( 'parses list with field=value args', () => {
		expect(
			parseCommandArgs( [ 'wp/v2', 'posts', 'list', 'per_page=5' ] )
		).toEqual( {
			mode: 'verb',
			namespace: 'wp/v2',
			route: 'posts',
			verb: 'list',
			fields: { per_page: '5' },
		} );
	} );

	it( 'parses get requiring an id as the first token after the verb', () => {
		expect( parseCommandArgs( [ 'wp/v2', 'posts', 'get', '42' ] ) ).toEqual(
			{
				mode: 'verb',
				namespace: 'wp/v2',
				route: 'posts',
				verb: 'get',
				id: '42',
				fields: {},
			}
		);
	} );

	it( 'throws when get is missing its id', () => {
		expect( () => parseCommandArgs( [ 'wp/v2', 'posts', 'get' ] ) ).toThrow(
			CliError
		);
	} );

	it( 'throws when get is given a field=value token instead of an id', () => {
		expect( () =>
			parseCommandArgs( [ 'wp/v2', 'posts', 'get', 'title=Hello' ] )
		).toThrow( CliError );
	} );

	it( 'parses update with an id and field=value args', () => {
		expect(
			parseCommandArgs( [
				'wp/v2',
				'posts',
				'update',
				'42',
				'title=Hello',
			] )
		).toEqual( {
			mode: 'verb',
			namespace: 'wp/v2',
			route: 'posts',
			verb: 'update',
			id: '42',
			fields: { title: 'Hello' },
		} );
	} );

	it( 'folds an unrecognised verb-position token into the route instead of rejecting it, since a route may legitimately be spelled as several words', () => {
		expect( parseCommandArgs( [ 'wp/v2', 'posts', 'destroy' ] ) ).toEqual( {
			mode: 'introspect',
			namespace: 'wp/v2',
			route: 'posts/destroy',
		} );
	} );

	it( 'throws when a field=value token appears before any verb', () => {
		expect( () =>
			parseCommandArgs( [ 'wp/v2', 'posts', 'title=Hello' ] )
		).toThrow( CliError );
	} );

	it( 'joins several route segments given as separate args, stopping at the verb', () => {
		expect(
			parseCommandArgs( [
				'wp/v2',
				'global-styles',
				'themes',
				'get',
				'twentytwentyfour',
			] )
		).toEqual( {
			mode: 'verb',
			namespace: 'wp/v2',
			route: 'global-styles/themes',
			verb: 'get',
			id: 'twentytwentyfour',
			fields: {},
		} );
	} );

	it( 'joins route segments with no verb into a single introspect route', () => {
		expect(
			parseCommandArgs( [ 'wp/v2', 'global-styles', 'themes' ] )
		).toEqual( {
			mode: 'introspect',
			namespace: 'wp/v2',
			route: 'global-styles/themes',
		} );
	} );

	it( 'splits field=value only on the first "="', () => {
		expect(
			parseCommandArgs( [ 'wp/v2', 'posts', 'create', 'content=a=b' ] )
		).toEqual( {
			mode: 'verb',
			namespace: 'wp/v2',
			route: 'posts',
			verb: 'create',
			fields: { content: 'a=b' },
		} );
	} );
} );
