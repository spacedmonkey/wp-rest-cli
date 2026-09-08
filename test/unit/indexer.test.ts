import { describe, expect, it } from 'vitest';
import {
  resolveRouteInfo,
  routesForNamespace,
  supportedVerbsForRoute,
} from '../../src/core/indexer.js';
import type { IndexResponse } from '../../src/types.js';

function schema(methods: string[]): IndexResponse['routes'][string] {
  return { namespace: 'wp/v2', methods, endpoints: methods.map((m) => ({ methods: [m] })) };
}

const index: IndexResponse = {
  namespaces: ['wp/v2'],
  routes: {
    '/wp/v2': schema(['GET']),
    '/wp/v2/posts': schema(['GET', 'POST']),
    '/wp/v2/posts/(?P<id>[\\d]+)': schema(['GET', 'PUT', 'DELETE']),
    '/wp/v2/posts/(?P<parent>[\\d]+)/autosaves': schema(['GET']),
    '/wp/v2/types': schema(['GET']),
    '/wp/v2/global-styles/themes/(?P<stylesheet>%s)': schema(['GET']),
  },
};

describe('routesForNamespace', () => {
  it('lists a normal collection route once, not its parameterised singular sibling', () => {
    const routes = routesForNamespace(index, 'wp/v2').map((r) => r.route);
    expect(routes).toContain('posts');
    expect(routes).not.toContain('posts/(?P<id>[\\d]+)');
  });

  it('lists the base of a route that only exists in parameterised form', () => {
    const routes = routesForNamespace(index, 'wp/v2').map((r) => r.route);
    expect(routes).toContain('global-styles/themes');
  });
});

describe('resolveRouteInfo', () => {
  it('resolves an exact route without requiring a parameter', () => {
    expect(resolveRouteInfo(index, 'wp/v2', 'posts')).toEqual({
      path: '/wp/v2/posts',
      requiresParam: false,
    });
  });

  it('resolves a parameterised-only route, flagging that it requires a parameter', () => {
    expect(resolveRouteInfo(index, 'wp/v2', 'global-styles/themes')).toEqual({
      path: '/wp/v2/global-styles/themes/(?P<stylesheet>%s)',
      requiresParam: true,
    });
  });

  it('falls back to treating an unknown route as exact, letting the caller surface the real error', () => {
    expect(resolveRouteInfo(index, 'wp/v2', 'nope')).toEqual({
      path: '/wp/v2/nope',
      requiresParam: false,
    });
  });
});

describe('supportedVerbsForRoute', () => {
  it('combines collection and item methods for a route with both', () => {
    expect(supportedVerbsForRoute(index, '/wp/v2/posts')).toEqual([
      'list',
      'get',
      'create',
      'update',
      'delete',
      'exists',
      'generate',
    ]);
  });

  it('reports only list for a GET-only route with no item endpoint', () => {
    expect(supportedVerbsForRoute(index, '/wp/v2/types')).toEqual(['list']);
  });

  it('treats a mid-path placeholder (not a trailing one) as a collection, not an item', () => {
    expect(supportedVerbsForRoute(index, '/wp/v2/posts/(?P<parent>[\\d]+)/autosaves')).toEqual([
      'list',
    ]);
  });

  it('maps GET to get/exists (not list) for a route that only exists in parameterised form', () => {
    expect(supportedVerbsForRoute(index, '/wp/v2/global-styles/themes/(?P<stylesheet>%s)')).toEqual(
      ['get', 'exists'],
    );
  });
});
