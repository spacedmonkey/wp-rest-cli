import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveApiRoot } from '../../src/core/discovery.js';
import { CliError } from '../../src/core/errors.js';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resolveApiRoot', () => {
  it('resolves via the HEAD Link header', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'HEAD') {
        return new Response(null, {
          status: 200,
          headers: { link: '<https://example.com/wp-json/>; rel="https://api.w.org/"' },
        });
      }
      throw new Error('should not reach GET fallback');
    });
    vi.stubGlobal('fetch', fetchMock);

    const root = await resolveApiRoot('example.com');
    expect(root).toBe('https://example.com/wp-json/');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to the HTML <link> tag when the HEAD response has no Link header', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'HEAD') {
        return new Response(null, { status: 200 });
      }
      return new Response(
        `<html><head><link rel="https://api.w.org/" href="https://example.com/wp-json/" /></head></html>`,
        { status: 200, headers: { 'content-type': 'text/html' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const root = await resolveApiRoot('example.com');
    expect(root).toBe('https://example.com/wp-json/');
  });

  it('falls back to probing /wp-json/ directly', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'HEAD') return new Response(null, { status: 200 });
      const target = url.toString();
      if (target === 'https://example.com/') {
        return new Response('<html></html>', { status: 200 });
      }
      if (target === 'https://example.com/wp-json/') {
        return jsonResponse({ routes: {} });
      }
      throw new Error(`unexpected request: ${target}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const root = await resolveApiRoot('example.com');
    expect(root).toBe('https://example.com/wp-json/');
  });

  it('throws a CliError when discovery exhausts every strategy', async () => {
    const fetchMock = vi.fn(async () => new Response('nope', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(resolveApiRoot('example.com')).rejects.toBeInstanceOf(CliError);
  });
});
