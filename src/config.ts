import Conf from 'conf';

interface StoredConfig {
  url?: string;
  username?: string;
}

// Password is never persisted here — only flags/env vars carry it (see plan: v1
// ships flags/env vars only; OS-keychain storage is a documented future option).
const store = new Conf<StoredConfig>({ projectName: 'wp-rest-cli' });

export function getDefaultUrl(): string | undefined {
  return store.get('url');
}

export function getDefaultUsername(): string | undefined {
  return store.get('username');
}

export function setDefaults(values: StoredConfig): void {
  if (values.url !== undefined) store.set('url', values.url);
  if (values.username !== undefined) store.set('username', values.username);
}

export function clearDefaults(): void {
  store.clear();
}

export function configFilePath(): string {
  return store.path;
}
