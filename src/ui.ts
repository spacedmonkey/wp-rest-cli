import ora, { type Ora } from 'ora';
import pc from 'picocolors';

export function spinner(text: string, enabled: boolean): Ora | undefined {
  if (!enabled) return undefined;
  return ora({ text, isEnabled: true }).start();
}

export async function withSpinner<T>(
  text: string,
  enabled: boolean,
  task: () => Promise<T>,
): Promise<T> {
  const spin = spinner(text, enabled);
  try {
    const result = await task();
    spin?.succeed(text);
    return result;
  } catch (error) {
    spin?.fail(text);
    throw error;
  }
}

export function success(message: string): string {
  return pc.green(`Success: ${message}`);
}

export function warn(message: string): string {
  return pc.yellow(`Warning: ${message}`);
}

export function errorText(message: string): string {
  return pc.red(message);
}

export { pc };
