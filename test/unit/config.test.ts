/**
 * External dependencies
 */
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import Conf from 'conf';
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
// `wrapido config get` integration tests, which read the real one).
let configModule: typeof import('../../src/config.js');
let tempDir: string;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;

beforeAll( async () => {
	tempDir = mkdtempSync( join( tmpdir(), 'wrapido-config-test-' ) );
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

describe( 'site credentials: application-passwords', () => {
	it( 'round-trips a stored credential', () => {
		configModule.setSiteCredential(
			'https://one.example.com',
			'application-passwords',
			{
				username: 'admin',
				password: 'xxxx-xxxx-xxxx-xxxx',
				authMethod: 'application-password',
			}
		);
		expect(
			configModule.getSiteCredential(
				'https://one.example.com/',
				'application-passwords'
			)
		).toEqual( {
			username: 'admin',
			password: 'xxxx-xxxx-xxxx-xxxx',
			authMethod: 'application-password',
		} );
	} );

	it( 'lists stored credentials without leaking passwords', () => {
		configModule.setSiteCredential(
			'https://two.example.com',
			'application-passwords',
			{
				username: 'editor',
				password: 'super-secret',
				authMethod: 'password',
			}
		);
		const sites = configModule.listSiteCredentials();
		const entry = sites.find(
			( site ) => site.url === 'https://two.example.com'
		);
		expect( entry ).toEqual( {
			url: 'https://two.example.com',
			authType: 'application-passwords',
			username: 'editor',
			authMethod: 'password',
		} );
		expect( JSON.stringify( sites ) ).not.toContain( 'super-secret' );
	} );

	it( 'removes a stored credential', () => {
		configModule.setSiteCredential(
			'https://three.example.com',
			'application-passwords',
			{
				username: 'admin',
				password: 'pw',
				authMethod: 'password',
			}
		);
		expect(
			configModule.removeSiteCredential(
				'https://three.example.com',
				'application-passwords'
			)
		).toBe( true );
		expect(
			configModule.getSiteCredential(
				'https://three.example.com',
				'application-passwords'
			)
		).toBeUndefined();
	} );

	it( 'reports false when removing a credential that was never stored', () => {
		expect(
			configModule.removeSiteCredential(
				'https://never-stored.example.com',
				'application-passwords'
			)
		).toBe( false );
	} );
} );

describe( 'site credentials: uuid', () => {
	it( 'round-trips the uuid field through setSiteCredential/getSiteCredential', () => {
		configModule.setSiteCredential(
			'https://uuid.example.com',
			'application-passwords',
			{
				username: 'admin',
				password: 'xxxx-xxxx-xxxx-xxxx',
				authMethod: 'application-password',
				uuid: 'abc-123-uuid',
			}
		);
		expect(
			configModule.getSiteCredential(
				'https://uuid.example.com',
				'application-passwords'
			)
		).toEqual( {
			username: 'admin',
			password: 'xxxx-xxxx-xxxx-xxxx',
			authMethod: 'application-password',
			uuid: 'abc-123-uuid',
		} );
	} );

	it( 'does not include uuid in listSiteCredentials, even when stored', () => {
		configModule.setSiteCredential(
			'https://uuid-list.example.com',
			'application-passwords',
			{
				username: 'admin',
				password: 'xxxx-xxxx-xxxx-xxxx',
				authMethod: 'application-password',
				uuid: 'should-not-leak',
			}
		);
		const entry = configModule
			.listSiteCredentials()
			.find( ( site ) => site.url === 'https://uuid-list.example.com' );
		expect( entry ).toEqual( {
			url: 'https://uuid-list.example.com',
			authType: 'application-passwords',
			username: 'admin',
			authMethod: 'application-password',
		} );
		expect( entry ).not.toHaveProperty( 'uuid' );
	} );
} );

describe( 'site credentials: oauth2', () => {
	it( 'round-trips a stored credential', () => {
		configModule.setSiteCredential(
			'https://oauth2.example.com',
			'oauth2',
			{
				accessToken: 'token-abc',
				clientId: 'client-123',
				grantType: 'authorization_code',
				tokenType: 'bearer',
			}
		);
		expect(
			configModule.getSiteCredential(
				'https://oauth2.example.com/',
				'oauth2'
			)
		).toEqual( {
			accessToken: 'token-abc',
			clientId: 'client-123',
			grantType: 'authorization_code',
			tokenType: 'bearer',
		} );
	} );

	it( 'lists stored oauth2 credentials without leaking the access token', () => {
		configModule.setSiteCredential(
			'https://oauth2-list.example.com',
			'oauth2',
			{
				accessToken: 'should-not-leak',
				clientId: 'client-456',
				grantType: 'client_credentials',
				tokenType: 'bearer',
			}
		);
		const sites = configModule.listSiteCredentials();
		const entry = sites.find(
			( site ) => site.url === 'https://oauth2-list.example.com'
		);
		expect( entry ).toEqual( {
			url: 'https://oauth2-list.example.com',
			authType: 'oauth2',
			clientId: 'client-456',
			grantType: 'client_credentials',
		} );
		expect( JSON.stringify( sites ) ).not.toContain( 'should-not-leak' );
	} );

	it( 'removes a stored oauth2 credential', () => {
		configModule.setSiteCredential(
			'https://oauth2-remove.example.com',
			'oauth2',
			{
				accessToken: 'token-xyz',
				clientId: 'client-789',
				grantType: 'client_credentials',
				tokenType: 'bearer',
			}
		);
		expect(
			configModule.removeSiteCredential(
				'https://oauth2-remove.example.com',
				'oauth2'
			)
		).toBe( true );
		expect(
			configModule.getSiteCredential(
				'https://oauth2-remove.example.com',
				'oauth2'
			)
		).toBeUndefined();
	} );

	it( 'reports false when removing an oauth2 credential that was never stored', () => {
		expect(
			configModule.removeSiteCredential(
				'https://oauth2-never-stored.example.com',
				'oauth2'
			)
		).toBe( false );
	} );

	it( 'round-trips a personal_token credential with no clientId', () => {
		configModule.setSiteCredential(
			'https://oauth2-personal.example.com',
			'oauth2',
			{
				accessToken: 'personal-token-abc',
				grantType: 'personal_token',
				tokenType: 'bearer',
			}
		);
		expect(
			configModule.getSiteCredential(
				'https://oauth2-personal.example.com',
				'oauth2'
			)
		).toEqual( {
			accessToken: 'personal-token-abc',
			grantType: 'personal_token',
			tokenType: 'bearer',
		} );

		const sites = configModule.listSiteCredentials();
		const entry = sites.find(
			( site ) => site.url === 'https://oauth2-personal.example.com'
		);
		expect( entry ).toEqual( {
			url: 'https://oauth2-personal.example.com',
			authType: 'oauth2',
			clientId: undefined,
			grantType: 'personal_token',
		} );
		expect( JSON.stringify( sites ) ).not.toContain( 'personal-token-abc' );
	} );
} );

describe( 'site credentials: cross-type isolation', () => {
	const url = 'https://both-types.example.com';

	it( 'setting an oauth2 credential does not disturb an existing application-passwords one for the same site', () => {
		configModule.setSiteCredential( url, 'application-passwords', {
			username: 'admin',
			password: 'app-pw',
			authMethod: 'application-password',
		} );
		configModule.setSiteCredential( url, 'oauth2', {
			accessToken: 'token-both',
			clientId: 'client-both',
			grantType: 'authorization_code',
			tokenType: 'bearer',
		} );

		expect(
			configModule.getSiteCredential( url, 'application-passwords' )
		).toEqual( {
			username: 'admin',
			password: 'app-pw',
			authMethod: 'application-password',
		} );
		expect( configModule.getSiteCredential( url, 'oauth2' ) ).toEqual( {
			accessToken: 'token-both',
			clientId: 'client-both',
			grantType: 'authorization_code',
			tokenType: 'bearer',
		} );
	} );

	it( 'removing one type leaves the other type stored for the same site untouched', () => {
		expect(
			configModule.removeSiteCredential( url, 'application-passwords' )
		).toBe( true );

		expect(
			configModule.getSiteCredential( url, 'application-passwords' )
		).toBeUndefined();
		expect( configModule.getSiteCredential( url, 'oauth2' ) ).toEqual( {
			accessToken: 'token-both',
			clientId: 'client-both',
			grantType: 'authorization_code',
			tokenType: 'bearer',
		} );
	} );
} );

describe( 'legacy sites shape migration', () => {
	it( 'reads a pre-multi-auth-type flat sites entry as an application-passwords credential', () => {
		const legacyUrl = 'https://legacy.example.com';

		// Writes the OLD flat shape directly on disk, bypassing
		// `setSiteCredential` (which only ever writes the new nested shape) —
		// a second `Conf` instance pointed at the same file/key simulates what
		// a pre-multi-auth-type version of this tool would have written.
		const configDir = dirname( configModule.configFilePath() );
		const encryptionKey = readFileSync(
			join( configDir, 'credential-key' ),
			'utf8'
		).trim();
		const rawStore = new Conf< { sites?: Record< string, unknown > } >( {
			projectName: 'wrapido',
			cwd: configDir,
			encryptionKey,
		} );
		const existingSites = rawStore.get( 'sites' ) ?? {};
		rawStore.set( 'sites', {
			...existingSites,
			[ legacyUrl ]: {
				username: 'legacy-admin',
				password: 'legacy-pw',
				authMethod: 'application-password',
				uuid: 'legacy-uuid',
			},
		} );

		expect(
			configModule.getSiteCredential( legacyUrl, 'application-passwords' )
		).toEqual( {
			username: 'legacy-admin',
			password: 'legacy-pw',
			authMethod: 'application-password',
			uuid: 'legacy-uuid',
		} );
		expect(
			configModule.getSiteCredential( legacyUrl, 'oauth2' )
		).toBeUndefined();
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
		configModule.setSiteCredential(
			'https://rotate-site.example.com',
			'application-passwords',
			{
				username: 'rotate-admin',
				password: 'rotate-pw',
				authMethod: 'application-password',
				uuid: 'rotate-uuid',
			}
		);

		const keyBefore = readFileSync( keyFilePath, 'utf8' );

		configModule.rotateEncryptionKey();

		const keyAfter = readFileSync( keyFilePath, 'utf8' );
		expect( keyAfter ).not.toBe( keyBefore );

		expect( configModule.getDefaultUrl() ).toBe(
			'https://rotate.example.com'
		);
		expect( configModule.getDefaultUsername() ).toBe( 'rotate-user' );
		expect(
			configModule.getSiteCredential(
				'https://rotate-site.example.com',
				'application-passwords'
			)
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
		configModule.setSiteCredential(
			'https://kept.example.com',
			'application-passwords',
			{
				username: 'admin',
				password: 'pw',
				authMethod: 'password',
			}
		);

		configModule.clearDefaults();

		expect( configModule.getDefaultUrl() ).toBeUndefined();
		expect( configModule.getDefaultUsername() ).toBeUndefined();
		expect(
			configModule.getSiteCredential(
				'https://kept.example.com',
				'application-passwords'
			)
		).toBeDefined();
	} );
} );
