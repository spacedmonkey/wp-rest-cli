/**
 * External dependencies
 */
import Conf from 'conf';
import envPaths from 'env-paths';
import { randomBytes } from 'node:crypto';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

/**
 * Internal dependencies
 */
import { CliError } from './core/errors.js';

/** One site's stored login, keyed by its normalized URL in {@link StoredConfig.sites}. */
interface StoredSiteCredential {
	username: string;
	password: string;
	authMethod: 'password' | 'application-password';
	// The application password's uuid on the site, if known — lets `wp auth
	// remove`/re-`login` revoke it server-side. Only ever set when confirmed
	// via introspection; absent for a plain account password.
	uuid?: string;
}

interface StoredConfig {
	url?: string;
	username?: string;
	sites?: Record< string, StoredSiteCredential >;
}

// This module resolves its own config directory (rather than letting `conf`
// pick its own default) so it can also place the encryption key file inside
// it, next to but separate from the config data — `conf` itself uses
// `env-paths` internally for this same resolution, so passing `cwd`
// explicitly here just makes that directory choice visible to this file too.
const configDir = envPaths( 'wp-rest-cli', { suffix: 'nodejs' } ).config;
const keyFilePath = join( configDir, 'credential-key' );

/**
 * Loads the per-machine encryption key from disk, generating one on first
 * use. Storing the key in its own file — separate from config.json — means a
 * leaked or copied config file alone can't be decrypted; the key file also
 * has to be obtained. This does not protect against something that already
 * has full read access to the same account (e.g. another process running as
 * the same user) — that would need an OS keychain, out of scope here.
 * @return The hex-encoded encryption key.
 */
function loadOrCreateEncryptionKey(): string {
	try {
		return readFileSync( keyFilePath, 'utf8' ).trim();
	} catch {
		mkdirSync( configDir, { recursive: true } );
		const key = randomBytes( 32 ).toString( 'hex' );
		try {
			// 'wx': fail if the file already exists — guards a race between two
			// concurrent first-run processes generating different keys.
			writeFileSync( keyFilePath, key, { mode: 0o600, flag: 'wx' } );
			return key;
		} catch {
			// Lost the race — another process just created it; use that one.
			return readFileSync( keyFilePath, 'utf8' ).trim();
		}
	}
}

/**
 * The one place `Conf`'s constructor options are assembled — every call site
 * below (`createStore`'s initial attempt and its recovery retry,
 * `rotateEncryptionKey`'s staged and verification instances) goes through
 * this rather than repeating the options object, so e.g. a future change to
 * `projectName` can't accidentally miss one of them.
 * @param cwd           The directory this instance's config file lives in.
 * @param encryptionKey The encryption key to use.
 * @return The options to pass to `new Conf(...)`.
 */
function confOptions(
	cwd: string,
	encryptionKey: string
): ConstructorParameters< typeof Conf< StoredConfig > >[ 0 ] {
	return { projectName: 'wp-rest-cli', cwd, encryptionKey };
}

/**
 * Constructs the real `Conf` instance, recovering instead of crashing if the
 * on-disk config file can't be decrypted/parsed with the current key (e.g.
 * the key file and config file came from different backups, or a previous
 * `rotateEncryptionKey()` was interrupted between writing one and the other —
 * see that function's own comment). `conf` reads the file eagerly at
 * construction time, so an unhandled error here would otherwise crash *every*
 * subsequent invocation of this CLI, not just the one that hit it — this
 * module is imported, and this function called, before `cli.ts`'s own
 * top-level try/catch is ever reached. Recovery never silently discards the
 * unreadable file: it's renamed aside for forensics/manual recovery, and a
 * warning is printed, before falling back to a fresh empty store.
 * @return The constructed store.
 */
function createStore(): Conf< StoredConfig > {
	try {
		return new Conf< StoredConfig >(
			confOptions( configDir, loadOrCreateEncryptionKey() )
		);
	} catch ( error ) {
		const realConfigFilePath = join( configDir, 'config.json' );
		if ( existsSync( realConfigFilePath ) ) {
			const backupPath = `${ realConfigFilePath }.unreadable-${ Date.now() }`;
			try {
				renameSync( realConfigFilePath, backupPath );
				process.stderr.write(
					`Warning: wp-rest-cli's stored config/credentials could not be read (${
						error instanceof Error ? error.message : String( error )
					}) — the key file and config file may be out of sync. The ` +
						`unreadable file was preserved at ${ backupPath }; starting ` +
						`with an empty store.\n`
				);
			} catch {
				// If even the backup rename fails, fall through and let the retry
				// below fail loudly too, rather than masking the original error.
			}
		}
		return new Conf< StoredConfig >(
			confOptions( configDir, loadOrCreateEncryptionKey() )
		);
	}
}

// `cwd` is passed explicitly so this module fully controls the directory both
// the config file and the key file live in, avoiding a circular "need the
// directory to make the key, need the key to make the store, need the store
// to know the directory" dependency. `{ mode: 0o600 }` (in
// loadOrCreateEncryptionKey/rotateEncryptionKey) restricts the key file to
// the owner on POSIX; Windows has no equivalent chmod bit, but the file still
// sits under the user's own profile directory, which Windows protects via
// NTFS ACLs by default.
// `let`, not `const`: rotateEncryptionKey() below needs to repoint this at a
// freshly-constructed instance, not just mutate the existing one's data (see
// that function's own comment for why).
let store = createStore();

/**
 * Regenerates the local encryption key and re-encrypts the existing store
 * under it. Used by `wp config rotate-key` — an incident-response escape
 * hatch if the local key file is ever suspected compromised.
 *
 * The new, fully-populated store is built and verified in a temporary
 * directory *before* either the real key file or the real config file is
 * touched, so a failure at that stage (disk full, a serialization error)
 * never risks the live data. Committing is then a single, fast, synchronous
 * `renameSync` (atomic on the same filesystem — the staging directory is
 * created inside `configDir`) followed immediately by the key file write —
 * about as small a window as two separate files allow for the key and data
 * to ever disagree, versus the much larger one a naive "delete the old file,
 * then construct/populate a new instance" approach would leave open. If that
 * narrow window is ever hit anyway (or the file/key otherwise fall out of
 * sync some other way, e.g. a partial restore from separate backups),
 * {@link createStore}'s own recovery path keeps every other command working
 * rather than crashing, and preserves the unreadable file instead of losing
 * it silently.
 *
 * `conf` decrypts eagerly — both on construction (it reads any existing file
 * up front) and on every subsequent `.get()` (it re-reads from disk each time
 * rather than caching in memory) — verified empirically. That's why the
 * module-level `store` binding has to be repointed at a freshly-constructed
 * instance here rather than just writing the decrypted snapshot back through
 * the OLD `store` object: that would just re-encrypt config.json under the
 * OLD key again (an instance's encryptionKey can't be changed after
 * construction), silently undoing the rotation on disk while leaving the
 * just-written new key file unable to decrypt it.
 */
export function rotateEncryptionKey(): void {
	const snapshot: StoredConfig = { ...store.store };
	const newKey = randomBytes( 32 ).toString( 'hex' );

	const stagingDir = mkdtempSync( join( configDir, '.rotate-key-' ) );
	try {
		const staged = new Conf< StoredConfig >(
			confOptions( stagingDir, newKey )
		);
		staged.store = snapshot;

		// Verify the staged store actually round-trips under the new key
		// before committing anything real.
		const verified = new Conf< StoredConfig >(
			confOptions( stagingDir, newKey )
		).store;
		if ( JSON.stringify( verified ) !== JSON.stringify( snapshot ) ) {
			throw new Error(
				'Key rotation verification failed; the store was left unchanged.'
			);
		}

		renameSync( staged.path, store.path );
		// Deliberate overwrite — no 'wx' guard, unlike loadOrCreateEncryptionKey:
		// this is an explicit, one-shot user-invoked rotation, not a
		// race-guarded lazy init.
		writeFileSync( keyFilePath, newKey, { mode: 0o600 } );
	} finally {
		rmSync( stagingDir, { recursive: true, force: true } );
	}

	// Repoint every exported function (they all close over this module-level
	// binding) at the newly-keyed instance, so the SAME process reads/writes
	// correctly immediately after rotation — not just the next invocation.
	store = createStore();
}

/**
 * Reads the persisted default `--url`, if one was set via `wp config set` or `wp auth application-passwords use`.
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
 * Only the keys present on `values` are updated.
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

/**
 * Removes the persisted default `--url`/`--username` (`wp config clear`).
 * Does not touch credentials saved via `wp auth` — use `wp auth application-passwords remove` for those.
 */
export function clearDefaults(): void {
	store.delete( 'url' );
	store.delete( 'username' );
}

/** Path to the on-disk config file backing this store, for `wp config get`'s display. */
export function configFilePath(): string {
	return store.path;
}

/**
 * Canonicalizes a site URL for use as a `sites` map key, so the same site
 * addressed with or without a trailing slash resolves to the same stored
 * credential. A non-ASCII hostname is punycode-encoded by `URL` itself as
 * part of this canonicalization (e.g. `https://münchen.example` becomes
 * `https://xn--mnchen-3ya.example`) — the correct, stable form to key on, but
 * worth knowing about since it's also what `wp auth application-passwords
 * list`/`wp auth application-passwords status` then display back, which
 * won't visually match what was typed.
 * @param  url The site URL to normalize.
 * @return The canonicalized URL, with no trailing slash.
 * @throws {CliError} If `url` isn't a valid URL once a scheme is assumed.
 */
export function normalizeSiteUrl( url: string ): string {
	const withProtocol = /^https?:\/\//.test( url ) ? url : `https://${ url }`;
	try {
		return new URL( withProtocol ).toString().replace( /\/$/, '' );
	} catch {
		throw new CliError( `"${ url }" is not a valid URL.` );
	}
}

/**
 * Reads the stored credential for a site, if one was saved via `wp auth
 * application-passwords login`/`wp auth application-passwords add`.
 * @param url The site URL to look up (normalized internally).
 * @return The stored credential, or undefined if none is saved for this site.
 */
export function getSiteCredential(
	url: string
): StoredSiteCredential | undefined {
	return store.get( 'sites' )?.[ normalizeSiteUrl( url ) ];
}

/**
 * Persists a credential for a site, keyed by its normalized URL.
 *
 * Like every other function here, this does a plain read-modify-write with
 * no cross-process locking — two `wp auth` invocations racing at the exact
 * same instant (e.g. a script adding/removing several sites in parallel)
 * could lose one's update. Accepted as a low-severity gap for a CLI that's
 * normally run interactively, one command at a time, rather than adding a
 * file-locking dependency for it.
 * @param url        The site URL to store the credential under.
 * @param credential The username/password (or Application Password) to save.
 */
export function setSiteCredential(
	url: string,
	credential: StoredSiteCredential
): void {
	const sites = store.get( 'sites' ) ?? {};
	sites[ normalizeSiteUrl( url ) ] = credential;
	store.set( 'sites', sites );
}

/**
 * Removes the stored credential for a site.
 * @param url The site URL to remove the credential for.
 * @return Whether a credential existed and was removed.
 */
export function removeSiteCredential( url: string ): boolean {
	const sites = store.get( 'sites' ) ?? {};
	const key = normalizeSiteUrl( url );
	if ( ! ( key in sites ) ) {
		return false;
	}
	delete sites[ key ];
	store.set( 'sites', sites );
	return true;
}

/**
 * Lists every stored site credential, without passwords, for `wp auth application-passwords list`.
 * @return Each stored site's URL, username, and auth method.
 */
export function listSiteCredentials(): Array< {
	url: string;
	username: string;
	authMethod: StoredSiteCredential[ 'authMethod' ];
} > {
	const sites = store.get( 'sites' ) ?? {};
	return Object.entries( sites ).map( ( [ url, credential ] ) => ( {
		url,
		username: credential.username,
		authMethod: credential.authMethod,
	} ) );
}
