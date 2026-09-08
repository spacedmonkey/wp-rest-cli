import { pc } from '../ui.js';

/** Prints a `--debug` diagnostic line to stderr, so it never pollutes stdout output that scripts may parse. */
export function debugLog(line: string): void {
  console.error(pc.dim(line));
}

/** Masks credential-bearing header values (e.g. `Authorization: Basic xxxx`) before they're logged. */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const redacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === 'authorization') {
      const [scheme] = value.split(' ');
      redacted[key] = `${scheme} <redacted>`;
    } else {
      redacted[key] = value;
    }
  }
  return redacted;
}
