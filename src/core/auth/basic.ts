import type { AuthProvider } from './types.js';

/**
 * HTTP Basic Auth. Works with a real WordPress account password, but a
 * WordPress core Application Password (Users > Profile > Application Passwords,
 * WP 5.6+) is strongly recommended: it's revocable and scoped, and uses the
 * exact same wire format, so nothing else about this class changes.
 */
export class BasicAuthProvider implements AuthProvider {
  constructor(
    private readonly username: string,
    private readonly password: string,
  ) {}

  async getHeaders(): Promise<Record<string, string>> {
    const token = Buffer.from(`${this.username}:${this.password}`, 'utf8').toString('base64');
    return { Authorization: `Basic ${token}` };
  }
}
