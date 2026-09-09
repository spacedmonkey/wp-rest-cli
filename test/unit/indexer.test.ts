/**
 * External dependencies
 */
import { describe, expect, it } from '@jest/globals';

/**
 * Internal dependencies
 */
import {
	resolveRouteInfo,
	routeChildren,
	routesForNamespace,
	supportedVerbsForRoute,
} from '../../src/core/indexer.js';
import type { IndexResponse } from '../../src/types.js';

function schema( methods: string[] ): IndexResponse[ 'routes' ][ string ] {
	return {
		namespace: 'wp/v2',
		methods,
		endpoints: methods.map( ( m ) => ( { methods: [ m ] } ) ),
	};
}

const index: IndexResponse = {
	namespaces: [ 'wp/v2' ],
	routes: {
		'/wp/v2': schema( [ 'GET' ] ),
		'/wp/v2/posts': schema( [ 'GET', 'POST' ] ),
		'/wp/v2/posts/(?P<id>[\\d]+)': schema( [ 'GET', 'PUT', 'DELETE' ] ),
		'/wp/v2/posts/(?P<parent>[\\d]+)/autosaves': schema( [ 'GET' ] ),
		'/wp/v2/types': schema( [ 'GET' ] ),
		'/wp/v2/global-styles/themes/(?P<stylesheet>%s)': schema( [ 'GET' ] ),
	},
};

describe( 'routesForNamespace', () => {
	it( 'lists a normal collection route once, not its parameterised singular sibling', () => {
		const routes = routesForNamespace( index, 'wp/v2' ).map(
			( r ) => r.route
		);
		expect( routes ).toContain( 'posts' );
		expect( routes ).not.toContain( 'posts/(?P<id>[\\d]+)' );
	} );

	it( 'lists the base of a route that only exists in parameterised form', () => {
		const routes = routesForNamespace( index, 'wp/v2' ).map(
			( r ) => r.route
		);
		expect( routes ).toContain( 'global-styles/themes' );
	} );

	it( 'lists a route with a parameter in the middle of its path, by joining its literal segments', () => {
		const routes = routesForNamespace( index, 'wp/v2' ).map(
			( r ) => r.route
		);
		expect( routes ).toContain( 'posts/autosaves' );
	} );
} );

describe( 'routeChildren', () => {
	it( 'is a no-op for a namespace where every route is single-segment', () => {
		const flatIndex: IndexResponse = {
			namespaces: [ 'wp/v2' ],
			routes: {
				'/wp/v2': schema( [ 'GET' ] ),
				'/wp/v2/posts': schema( [ 'GET', 'POST' ] ),
				'/wp/v2/posts/(?P<id>[\\d]+)': schema( [
					'GET',
					'PUT',
					'DELETE',
				] ),
				'/wp/v2/types': schema( [ 'GET' ] ),
			},
		};
		const children = routeChildren( flatIndex, 'wp/v2', '' );
		const flatRoutes = routesForNamespace( flatIndex, 'wp/v2' );
		expect( children.map( ( c ) => c.segment ).sort() ).toEqual(
			flatRoutes.map( ( r ) => r.route ).sort()
		);
		expect( children.every( ( c ) => ! c.hasChildren ) ).toBe( true );
	} );

	it( 'groups a route registered only in parameterised form under its first segment', () => {
		const rootChildren = routeChildren( index, 'wp/v2', '' );
		const globalStyles = rootChildren.find(
			( c ) => c.segment === 'global-styles'
		);
		expect( globalStyles ).toEqual( {
			segment: 'global-styles',
			route: 'global-styles',
			hasChildren: true,
		} );
		expect(
			rootChildren.some( ( c ) => c.segment === 'global-styles/themes' )
		).toBe( false );
	} );

	it( 'lists the next segment when drilling into a container prefix', () => {
		expect( routeChildren( index, 'wp/v2', 'global-styles' ) ).toEqual( [
			{
				segment: 'themes',
				route: 'global-styles/themes',
				hasChildren: false,
			},
		] );
	} );

	it( 'marks a route as a "hybrid" when it is both directly addressable and has a child (a mid-path parameter route beneath it)', () => {
		const rootChildren = routeChildren( index, 'wp/v2', '' );
		expect( rootChildren.find( ( c ) => c.segment === 'posts' ) ).toEqual( {
			segment: 'posts',
			route: 'posts',
			hasChildren: true,
		} );
		expect( routeChildren( index, 'wp/v2', 'posts' ) ).toEqual( [
			{
				segment: 'autosaves',
				route: 'posts/autosaves',
				hasChildren: false,
			},
		] );
	} );

	it( 'returns no children once the full leaf route is reached', () => {
		expect(
			routeChildren( index, 'wp/v2', 'global-styles/themes' )
		).toEqual( [] );
	} );

	it( 'recurses to arbitrary depth (three literal segments deep)', () => {
		const deepIndex: IndexResponse = {
			namespaces: [ 'wp/v2' ],
			routes: {
				'/wp/v2/gizmos/parts/electronic/(?P<id>[\\d]+)': schema( [
					'GET',
				] ),
			},
		};
		expect( routeChildren( deepIndex, 'wp/v2', '' ) ).toEqual( [
			{ segment: 'gizmos', route: 'gizmos', hasChildren: true },
		] );
		expect( routeChildren( deepIndex, 'wp/v2', 'gizmos' ) ).toEqual( [
			{ segment: 'parts', route: 'gizmos/parts', hasChildren: true },
		] );
		expect( routeChildren( deepIndex, 'wp/v2', 'gizmos/parts' ) ).toEqual( [
			{
				segment: 'electronic',
				route: 'gizmos/parts/electronic',
				hasChildren: false,
			},
		] );
		expect(
			routeChildren( deepIndex, 'wp/v2', 'gizmos/parts/electronic' )
		).toEqual( [] );
	} );
} );

describe( 'resolveRouteInfo', () => {
	it( 'resolves an exact route without requiring a parameter', () => {
		expect( resolveRouteInfo( index, 'wp/v2', 'posts' ) ).toEqual( {
			path: '/wp/v2/posts',
			requiresParam: false,
		} );
	} );

	it( 'resolves a parameterised-only route, flagging that it requires a parameter and where it belongs (trailing, so at the end)', () => {
		expect(
			resolveRouteInfo( index, 'wp/v2', 'global-styles/themes' )
		).toEqual( {
			path: '/wp/v2/global-styles/themes/(?P<stylesheet>%s)',
			requiresParam: true,
			paramIndex: 2,
		} );
	} );

	it( 'resolves a route with a parameter in the middle of its path, reporting where it belongs', () => {
		expect( resolveRouteInfo( index, 'wp/v2', 'posts/autosaves' ) ).toEqual(
			{
				path: '/wp/v2/posts/(?P<parent>[\\d]+)/autosaves',
				requiresParam: true,
				paramIndex: 1,
			}
		);
	} );

	it( 'falls back to treating an unknown route as exact, letting the caller surface the real error', () => {
		expect( resolveRouteInfo( index, 'wp/v2', 'nope' ) ).toEqual( {
			path: '/wp/v2/nope',
			requiresParam: false,
		} );
	} );
} );

describe( 'supportedVerbsForRoute', () => {
	it( 'combines collection and item methods for a route with both', () => {
		expect( supportedVerbsForRoute( index, '/wp/v2/posts' ) ).toEqual( [
			'list',
			'get',
			'create',
			'update',
			'delete',
			'exists',
			'generate',
		] );
	} );

	it( 'reports only list for a GET-only route with no item endpoint', () => {
		expect( supportedVerbsForRoute( index, '/wp/v2/types' ) ).toEqual( [
			'list',
		] );
	} );

	it( 'treats a mid-path placeholder (not a trailing one) as a collection, but still addressable via get/exists since it needs a value', () => {
		expect(
			supportedVerbsForRoute(
				index,
				'/wp/v2/posts/(?P<parent>[\\d]+)/autosaves'
			)
		).toEqual( [ 'list', 'get', 'exists' ] );
	} );

	it( 'maps GET to get/exists (not list) for a route that only exists in parameterised form', () => {
		expect(
			supportedVerbsForRoute(
				index,
				'/wp/v2/global-styles/themes/(?P<stylesheet>%s)'
			)
		).toEqual( [ 'get', 'exists' ] );
	} );
} );
