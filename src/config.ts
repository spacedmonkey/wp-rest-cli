import Conf from 'conf';

interface StoredConfig {
	url?: string;
	username?: string;
}

// Password is never persisted here — only flags/env vars carry it (see plan: v1
// ships flags/env vars only; OS-keychain storage is a documented future option).
const store = new Conf< StoredConfig >( { projectName: 'wp-rest-cli' } );

/**
 * Reads the persisted default `--url`, if one was set via `wp config set`.
 * @return The stored site URL, or undefined if none is set.
 */
export function getDefaultUrl(): string | undefined {
	return store.get( 'url' );
}

/**
 * Reads the persisted default `--username`, if one was set via `wp config set`.
 * @return The stored username, or undefined if none is set.
 */
export function getDefaultUsername(): string | undefined {
	return store.get( 'username' );
}

/**
 * Persists default `--url`/`--username` values to disk for future invocations.
 * Only the keys present on `values` are updated; the password is never stored.
 * @param values The url/username to persist.
 */
export function setDefaults( values: StoredConfig ): void {
	if ( values.url !== undefined ) {
		store.set( 'url', values.url );
	}
	if ( values.username !== undefined ) {
		store.set( 'username', values.username );
	}
}

/** Removes every persisted default (`wp config clear`). */
export function clearDefaults(): void {
	store.clear();
}

/** Path to the on-disk config file backing this store, for `wp config get`'s display. */
export function configFilePath(): string {
	return store.path;
}
