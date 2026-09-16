/**
 * External dependencies
 */
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Internal dependencies
 */
import { CliError } from '../../src/core/errors.js';

// `conf`'s store is created once at module load time, keyed off
// `XDG_CONFIG_HOME` — so it has to be pointed at a scratch directory *before*
// `../../src/config.js` is ever imported, and Jest's static `import` would
// otherwise run before this file's own top-level code does. A dynamic
// `import()` inside `beforeAll`, after setting the env var, is what makes
// this test suite isolated from whatever real config file already exists on
// the machine running it (a pre-existing gap this suite also closes for the
// `wp config get` integration tests, which read the real one).
let configModule: typeof import('../../src/config.js');
let tempDir: string;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;

beforeAll( async () => {
	tempDir = mkdtempSync( join( tmpdir(), 'wp-rest-cli-config-test-' ) );
	process.env.XDG_CONFIG_HOME = tempDir;
	configModule = await import( '../../src/config.js' );
} );

afterAll( () => {
	rmSync( tempDir, { recursive: true, force: true } );
	// Restore rather than just delete — a real XDG_CONFIG_HOME set in the
	// environment this test runs in (uncommon, but possible) shouldn't be
	// wiped out for whatever runs after this file in the same process.
	if ( originalXdgConfigHome === undefined ) {
		delete process.env.XDG_CONFIG_HOME;
	} else {
		process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
	}
} );

describe( 'normalizeSiteUrl', () => {
	it( 'strips a trailing slash', () => {
		expect( configModule.normalizeSiteUrl( 'https://example.com/' ) ).toBe(
			'https://example.com'
		);
	} );

	it( 'adds https:// when no protocol is given', () => {
		expect( configModule.normalizeSiteUrl( 'example.com' ) ).toBe(
			'https://example.com'
		);
	} );

	it( 'treats the same site with or without a trailing slash as the same key', () => {
		expect( configModule.normalizeSiteUrl( 'https://example.com' ) ).toBe(
			configModule.normalizeSiteUrl( 'https://example.com/' )
		);
	} );

	it( 'punycode-encodes a non-ASCII hostname', () => {
		expect(
			configModule.normalizeSiteUrl( 'https://münchen.example' )
		).toBe( 'https://xn--mnchen-3ya.example' );
	} );

	it( 'throws a CliError, not a raw URL error, for an unparseable url', () => {
		expect( () => configModule.normalizeSiteUrl( ' ' ) ).toThrow(
			CliError
		);
	} );
} );

describe( 'site credentials', () => {
	it( 'round-trips a stored credential', () => {
		configModule.setSiteCredential( 'https://one.example.com', {
			username: 'admin',
			password: 'xxxx-xxxx-xxxx-xxxx',
			authMethod: 'application-password',
		} );
		expect(
			configModule.getSiteCredential( 'https://one.example.com/' )
		).toEqual( {
			username: 'admin',
			password: 'xxxx-xxxx-xxxx-xxxx',
			authMethod: 'application-password',
		} );
	} );

	it( 'lists stored credentials without leaking passwords', () => {
		configModule.setSiteCredential( 'https://two.example.com', {
			username: 'editor',
			password: 'super-secret',
			authMethod: 'password',
		} );
		const sites = configModule.listSiteCredentials();
		const entry = sites.find(
			( site ) => site.url === 'https://two.example.com'
		);
		expect( entry ).toEqual( {
			url: 'https://two.example.com',
			username: 'editor',
			authMethod: 'password',
		} );
		expect( JSON.stringify( sites ) ).not.toContain( 'super-secret' );
	} );

	it( 'removes a stored credential', () => {
		configModule.setSiteCredential( 'https://three.example.com', {
			username: 'admin',
			password: 'pw',
			authMethod: 'password',
		} );
		expect(
			configModule.removeSiteCredential( 'https://three.example.com' )
		).toBe( true );
		expect(
			configModule.getSiteCredential( 'https://three.example.com' )
		).toBeUndefined();
	} );

	it( 'reports false when removing a credential that was never stored', () => {
		expect(
			configModule.removeSiteCredential(
				'https://never-stored.example.com'
			)
		).toBe( false );
	} );
} );

describe( 'site credentials: uuid', () => {
	it( 'round-trips the uuid field through setSiteCredential/getSiteCredential', () => {
		configModule.setSiteCredential( 'https://uuid.example.com', {
			username: 'admin',
			password: 'xxxx-xxxx-xxxx-xxxx',
			authMethod: 'application-password',
			uuid: 'abc-123-uuid',
		} );
		expect(
			configModule.getSiteCredential( 'https://uuid.example.com' )
		).toEqual( {
			username: 'admin',
			password: 'xxxx-xxxx-xxxx-xxxx',
			authMethod: 'application-password',
			uuid: 'abc-123-uuid',
		} );
	} );

	it( 'does not include uuid in listSiteCredentials, even when stored', () => {
		configModule.setSiteCredential( 'https://uuid-list.example.com', {
			username: 'admin',
			password: 'xxxx-xxxx-xxxx-xxxx',
			authMethod: 'application-password',
			uuid: 'should-not-leak',
		} );
		const entry = configModule
			.listSiteCredentials()
			.find( ( site ) => site.url === 'https://uuid-list.example.com' );
		expect( entry ).toEqual( {
			url: 'https://uuid-list.example.com',
			username: 'admin',
			authMethod: 'application-password',
		} );
		expect( entry ).not.toHaveProperty( 'uuid' );
	} );
} );

describe( 'encryption key file', () => {
	it( 'persists a non-empty key file alongside the config file', () => {
		const keyFilePath = join(
			dirname( configModule.configFilePath() ),
			'credential-key'
		);
		expect( existsSync( keyFilePath ) ).toBe( true );
		const key = readFileSync( keyFilePath, 'utf8' ).trim();
		expect( key.length ).toBeGreaterThan( 0 );
	} );
} );

describe( 'rotateEncryptionKey', () => {
	it( 'changes the on-disk key file and still reads back identical data afterward', () => {
		const keyFilePath = join(
			dirname( configModule.configFilePath() ),
			'credential-key'
		);

		configModule.setDefaults( {
			url: 'https://rotate.example.com',
			username: 'rotate-user',
		} );
		configModule.setSiteCredential( 'https://rotate-site.example.com', {
			username: 'rotate-admin',
			password: 'rotate-pw',
			authMethod: 'application-password',
			uuid: 'rotate-uuid',
		} );

		const keyBefore = readFileSync( keyFilePath, 'utf8' );

		configModule.rotateEncryptionKey();

		const keyAfter = readFileSync( keyFilePath, 'utf8' );
		expect( keyAfter ).not.toBe( keyBefore );

		expect( configModule.getDefaultUrl() ).toBe(
			'https://rotate.example.com'
		);
		expect( configModule.getDefaultUsername() ).toBe( 'rotate-user' );
		expect(
			configModule.getSiteCredential( 'https://rotate-site.example.com' )
		).toEqual( {
			username: 'rotate-admin',
			password: 'rotate-pw',
			authMethod: 'application-password',
			uuid: 'rotate-uuid',
		} );
	} );
} );

describe( 'clearDefaults', () => {
	it( 'clears only the default url/username, not stored site credentials', () => {
		configModule.setDefaults( {
			url: 'https://default.example.com',
			username: 'admin',
		} );
		configModule.setSiteCredential( 'https://kept.example.com', {
			username: 'admin',
			password: 'pw',
			authMethod: 'password',
		} );

		configModule.clearDefaults();

		expect( configModule.getDefaultUrl() ).toBeUndefined();
		expect( configModule.getDefaultUsername() ).toBeUndefined();
		expect(
			configModule.getSiteCredential( 'https://kept.example.com' )
		).toBeDefined();
	} );
} );
