import type { WpRestClient } from './client.js';
import type { RouteSchema } from '../types.js';

/**
 * Introspect a single route via an OPTIONS request (equivalent to appending
 * ?_method=OPTIONS for clients that can't send the verb directly), returning
 * its supported methods and per-method argument schema.
 */
export async function introspectRoute(
  client: WpRestClient,
  routeUrl: string,
): Promise<RouteSchema> {
  const { body } = await client.request<RouteSchema>(routeUrl, { method: 'OPTIONS' });
  return body;
}

/** Union of every `context` enum value referenced across a route's endpoint args. */
export function supportedContexts(schema: RouteSchema): string[] {
  const values = new Set<string>();
  for (const endpoint of schema.endpoints ?? []) {
    const contextArg = endpoint.args?.context;
    for (const value of contextArg?.enum ?? []) {
      values.add(value);
    }
  }
  return [...values];
}
