import type { AuthProvider } from './auth/types.js';
import { parseErrorResponse } from './errors.js';
import { debugLog, redactHeaders } from './debug.js';

export interface RequestOptions {
  method?: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface WpResponse<T = unknown> {
  status: number;
  headers: Headers;
  body: T;
}

export class WpRestClient {
  constructor(
    private readonly auth?: AuthProvider,
    private readonly debug = false,
  ) {}

  async request<T = unknown>(url: string, options: RequestOptions = {}): Promise<WpResponse<T>> {
    const target = new URL(url);
    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) {
        if (value !== undefined) target.searchParams.set(key, String(value));
      }
    }

    const authHeaders = this.auth ? await this.auth.getHeaders() : {};
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...authHeaders,
      ...options.headers,
    };

    let body: string | undefined;
    if (options.body !== undefined) {
      body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
      headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';
    }

    const method = options.method ?? 'GET';
    if (this.debug) {
      debugLog(`→ ${method} ${target.toString()}`);
      for (const [key, value] of Object.entries(redactHeaders(headers))) {
        debugLog(`  ${key}: ${value}`);
      }
      if (body) debugLog(`  body: ${body}`);
    }

    const startedAt = Date.now();
    const response = await fetch(target, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
    });

    if (this.debug) {
      debugLog(`← ${response.status} ${response.statusText} (${Date.now() - startedAt}ms)`);
    }

    if (!response.ok) {
      throw await parseErrorResponse(response);
    }

    if (options.method === 'HEAD') {
      return { status: response.status, headers: response.headers, body: undefined as T };
    }

    const text = await response.text();
    const parsed = text ? (JSON.parse(text) as T) : (undefined as T);
    return { status: response.status, headers: response.headers, body: parsed };
  }
}
