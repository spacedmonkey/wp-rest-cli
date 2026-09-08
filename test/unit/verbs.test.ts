import { describe, expect, it } from 'vitest';
import { buildVerbRequest } from '../../src/core/verbs.js';
import { CliError } from '../../src/core/errors.js';

const apiRoot = 'https://example.com/wp-json/';

describe('buildVerbRequest', () => {
  it('builds a GET request for list with query args and context', () => {
    const req = buildVerbRequest({
      verb: 'list',
      apiRoot,
      namespace: 'wp/v2',
      route: 'posts',
      context: 'view',
      fields: { per_page: '5' },
    });
    expect(req.method).toBe('GET');
    expect(req.url).toBe('https://example.com/wp-json/wp/v2/posts?context=view&per_page=5');
    expect(req.body).toBeUndefined();
  });

  it('builds a GET request for get requiring an id', () => {
    const req = buildVerbRequest({
      verb: 'get',
      apiRoot,
      namespace: 'wp/v2',
      route: 'posts',
      id: '42',
      context: 'edit',
      fields: {},
    });
    expect(req.method).toBe('GET');
    expect(req.url).toBe('https://example.com/wp-json/wp/v2/posts/42?context=edit');
  });

  it('throws a CliError when get is missing an id', () => {
    expect(() =>
      buildVerbRequest({
        verb: 'get',
        apiRoot,
        namespace: 'wp/v2',
        route: 'posts',
        context: 'view',
        fields: {},
      }),
    ).toThrow(CliError);
  });

  it('builds a POST request for create with a body from fields', () => {
    const req = buildVerbRequest({
      verb: 'create',
      apiRoot,
      namespace: 'wp/v2',
      route: 'posts',
      context: 'view',
      fields: { title: 'Hello', status: 'publish' },
    });
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://example.com/wp-json/wp/v2/posts');
    expect(req.body).toEqual({ title: 'Hello', status: 'publish' });
  });

  it('prefers --content over field=value args, merging fields on top', () => {
    const req = buildVerbRequest({
      verb: 'create',
      apiRoot,
      namespace: 'wp/v2',
      route: 'posts',
      context: 'view',
      fields: { status: 'draft' },
      content: { title: 'From content', status: 'publish' },
    });
    expect(req.body).toEqual({ title: 'From content', status: 'draft' });
  });

  it('builds a PUT request for update against the singular URL', () => {
    const req = buildVerbRequest({
      verb: 'update',
      apiRoot,
      namespace: 'wp/v2',
      route: 'posts',
      id: '42',
      context: 'view',
      fields: { title: 'Updated' },
    });
    expect(req.method).toBe('PUT');
    expect(req.url).toBe('https://example.com/wp-json/wp/v2/posts/42');
    expect(req.body).toEqual({ title: 'Updated' });
  });

  it('builds a DELETE request with query fields (e.g. force)', () => {
    const req = buildVerbRequest({
      verb: 'delete',
      apiRoot,
      namespace: 'wp/v2',
      route: 'posts',
      id: '42',
      context: 'view',
      fields: { force: 'true' },
    });
    expect(req.method).toBe('DELETE');
    expect(req.url).toBe('https://example.com/wp-json/wp/v2/posts/42?force=true');
  });
});
