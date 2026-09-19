/**
 * External dependencies
 */
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Internal dependencies
 */
import { runCli } from './fixtures/run-cli.js';
import {
	getDeletedMediaIds,
	getDownloadRequests,
	getPostProcessHits,
	getReceivedUploads,
	startFixture,
	type Fixture,
} from './fixtures/server.js';

let fixture: Fixture;
let dir: string;

/**
 * Writes a small file into the shared temp directory.
 *
 * @param name     The filename.
 * @param contents The file contents.
 * @return The absolute path.
 */
async function makeFile( name: string, contents = 'FILE-BYTES' ) {
	const file = path.join( dir, name );
	await writeFile( file, contents );
	return file;
}

beforeAll( async () => {
	fixture = await startFixture();
	dir = await mkdtemp( path.join( tmpdir(), 'wp-rest-cli-upload-' ) );
} );

afterAll( async () => {
	await fixture.close();
	await rm( dir, { recursive: true, force: true } );
} );

/**
 * Runs the CLI against the fixture, quietly.
 *
 * @param args Extra CLI arguments.
 * @return The execa result.
 */
function run( args: string[] ) {
	return runCli( [
		...args,
		`--url=${ fixture.baseUrl }`,
		'--quiet',
		'--no-color',
	] );
}

/** @return The most recent upload the fixture received. */
function lastUpload() {
	const uploads = getReceivedUploads();
	return uploads[ uploads.length - 1 ]!;
}

describe( 'uploading local files', () => {
	it( 'uploads a file to core media with a bare --file and sends other fields as form fields', async () => {
		const file = await makeFile( 'cat.jpg', 'JPEG-BYTES' );
		const result = await run( [
			'wp/v2',
			'media',
			'create',
			`--file=${ file }`,
			'--title=Cat',
			'--alt_text=A cat',
		] );
		expect( result.exitCode ).toBe( 0 );
		expect( result.stdout ).toMatch( /Success: Created media \d+\./ );
		const upload = lastUpload();
		expect( upload.files ).toEqual( [
			{ field: 'file', name: 'cat.jpg', type: 'image/jpeg', size: 10 },
		] );
		expect( upload.fields ).toEqual( { title: 'Cat', alt_text: 'A cat' } );
	} );

	it( 'uses @ on any field name, and an @@ prefix sends a literal @', async () => {
		const file = await makeFile( 'doc.pdf' );
		const result = await run( [
			'wp/v2',
			'attachments-custom',
			'create',
			`--attachment=@${ file }`,
			'--title=@@literal',
			'--format=json',
		] );
		expect( result.exitCode ).toBe( 0 );
		expect( lastUpload().files[ 0 ] ).toMatchObject( {
			field: 'attachment',
			name: 'doc.pdf',
			type: 'application/pdf',
		} );
		expect( lastUpload().fields ).toEqual( { title: '@literal' } );
	} );

	it( 'treats a bare path as a file when the route schema declares the arg format: binary', async () => {
		const file = await makeFile( 'schema.png' );
		const result = await run( [
			'wp/v2',
			'attachments-custom',
			'create',
			`--attachment=${ file }`,
		] );
		expect( result.exitCode ).toBe( 0 );
		expect( lastUpload().files[ 0 ]?.name ).toBe( 'schema.png' );
	} );

	it( 'leaves a bare --file as a normal string field on other routes', async () => {
		const result = await run( [
			'wp/v2',
			'widgets',
			'create',
			'--title=Plain',
			'--file=./not-a-file.jpg',
		] );
		expect( result.exitCode ).toBe( 0 );
	} );

	it( 'uploads several files, one request each, and lists their ids', async () => {
		const a = await makeFile( 'a.png' );
		const b = await makeFile( 'b.png' );
		const before = getReceivedUploads().length;
		const result = await run( [
			'wp/v2',
			'media',
			'create',
			`--file=${ a }`,
			`--file=${ b }`,
			'--format=ids',
		] );
		expect( result.exitCode ).toBe( 0 );
		expect( result.stdout.trim().split( /\s+/ ) ).toHaveLength( 2 );
		expect( getReceivedUploads().length - before ).toBe( 2 );
	} );

	it( 'reports a failing file, still uploads the rest, and exits 1', async () => {
		const good = await makeFile( 'good.png' );
		const bad = await makeFile( 'noperm.bin' );
		const result = await run( [
			'wp/v2',
			'media',
			'create',
			`--file=${ bad }`,
			`--file=${ good }`,
			'--format=ids',
		] );
		expect( result.exitCode ).toBe( 1 );
		expect( result.stdout.trim().split( /\s+/ ) ).toHaveLength( 1 );
		expect( result.stderr ).toContain( 'noperm.bin' );
		expect( result.stderr ).toContain( 'rest_upload_unknown_error' );
		expect( result.stderr ).toContain( '1 of 2 uploads failed' );
	} );

	it( 'fails early for a missing, empty or non-regular file, sending nothing', async () => {
		const before = getReceivedUploads().length;
		const empty = await makeFile( 'empty.png', '' );
		const missing = await run( [
			'wp/v2',
			'media',
			'create',
			`--file=${ path.join( dir, 'nope.png' ) }`,
		] );
		expect( missing.exitCode ).toBe( 1 );
		expect( missing.stderr ).toContain( "File doesn't exist" );
		const emptyResult = await run( [
			'wp/v2',
			'media',
			'create',
			`--file=${ empty }`,
		] );
		expect( emptyResult.stderr ).toContain( 'File is empty' );
		const directory = await run( [
			'wp/v2',
			'media',
			'create',
			`--file=${ dir }`,
		] );
		expect( directory.stderr ).toContain( 'Not a regular file' );
		const broken = path.join( dir, 'broken-link' );
		await symlink( path.join( dir, 'gone' ), broken );
		const brokenResult = await run( [
			'wp/v2',
			'media',
			'create',
			`--file=${ broken }`,
		] );
		expect( brokenResult.stderr ).toContain( "File doesn't exist" );
		expect( getReceivedUploads().length ).toBe( before );
	} );

	it( 'rejects --body together with a file', async () => {
		const file = await makeFile( 'body.png' );
		const result = await run( [
			'wp/v2',
			'media',
			'create',
			`--file=${ file }`,
			'--body={"a":1}',
		] );
		expect( result.exitCode ).toBe( 1 );
		expect( result.stderr ).toContain( '--body cannot be combined' );
	} );
} );

describe( 'upload errors', () => {
	it( 'explains a 413 without dumping the HTML page', async () => {
		const file = await makeFile( '413.bin' );
		const result = await run( [
			'wp/v2',
			'media',
			'create',
			`--file=${ file }`,
		] );
		expect( result.exitCode ).toBe( 1 );
		expect( result.stderr ).toContain( 'too large (HTTP 413)' );
		expect( result.stderr ).not.toContain( '<html>' );
	} );

	it( 'appends a hint to rest_upload_* errors', async () => {
		const file = await makeFile( 'noperm.bin' );
		const result = await run( [
			'wp/v2',
			'media',
			'create',
			`--file=${ file }`,
		] );
		expect( result.stderr ).toContain(
			'Sorry, you are not allowed to upload this file type.'
		);
		expect( result.stderr ).toContain( 'upload_max_filesize' );
	} );

	it( 'retries sub-size generation, then removes the orphaned attachment', async () => {
		const file = await makeFile( 'crash.png' );
		const result = await run( [
			'wp/v2',
			'media',
			'create',
			`--file=${ file }`,
		] );
		expect( result.exitCode ).toBe( 1 );
		expect( getPostProcessHits().get( 77 ) ).toBe( 5 );
		expect( getDeletedMediaIds() ).toContain( 77 );
		expect( result.stderr ).toContain( 'generating image sizes' );
	} );

	it( 'succeeds when a post-process retry recovers the upload', async () => {
		const file = await makeFile( 'recover.png' );
		const result = await run( [
			'wp/v2',
			'media',
			'create',
			`--file=${ file }`,
			'--format=ids',
		] );
		expect( result.exitCode ).toBe( 0 );
		expect( result.stdout.trim() ).toBe( '78' );
		expect( getDeletedMediaIds() ).not.toContain( 78 );
	} );

	it( 'never logs credentials or file bytes with --debug', async () => {
		const file = await makeFile( 'debug.png', 'SECRET-FILE-BYTES' );
		const result = await runCli( [
			'wp/v2',
			'media',
			'create',
			`--file=${ file }`,
			'--title=T',
			'--username=user',
			'--password=hunter2',
			`--url=${ fixture.baseUrl }`,
			'--debug',
			'--no-color',
		] );
		expect( result.exitCode ).toBe( 0 );
		expect( result.stderr ).toContain( 'multipart' );
		expect( result.stderr ).not.toContain( 'hunter2' );
		expect( result.stderr ).not.toContain( 'SECRET-FILE-BYTES' );
	} );
} );

describe( 'site-allowed file types', () => {
	it( 'refuses a type the site does not allow, before uploading', async () => {
		const file = await makeFile( 'nope.gif' );
		const before = getReceivedUploads().length;
		const result = await run( [
			'wp/v2',
			'media',
			'create',
			`--file=${ file }`,
			'--username=mimeuser',
			'--password=x',
		] );
		expect( result.exitCode ).toBe( 1 );
		expect( result.stderr ).toContain( 'does not allow' );
		expect( getReceivedUploads().length ).toBe( before );
	} );

	it( 'allows a listed type, and skips the check when the list is unavailable', async () => {
		const png = await makeFile( 'ok.png' );
		const allowed = await run( [
			'wp/v2',
			'media',
			'create',
			`--file=${ png }`,
			'--username=mimeuser',
			'--password=x',
		] );
		expect( allowed.exitCode ).toBe( 0 );
		const gif = await makeFile( 'skip.gif' );
		for ( const username of [ 'forbidden', 'someone' ] ) {
			const result = await run( [
				'wp/v2',
				'media',
				'create',
				`--file=${ gif }`,
				`--username=${ username }`,
				'--password=x',
			] );
			expect( result.exitCode ).toBe( 0 );
		}
	} );
} );

describe( 'uploading from a URL', () => {
	it( 'downloads then uploads, never sending WordPress credentials to the source', async () => {
		const result = await run( [
			'wp/v2',
			'media',
			'create',
			`--file=@${ fixture.baseUrl }/downloads/cat.jpg`,
			'--username=user',
			'--password=hunter2',
		] );
		expect( result.exitCode ).toBe( 0 );
		expect( lastUpload().files[ 0 ] ).toMatchObject( {
			name: 'cat.jpg',
			type: 'image/jpeg',
			size: 1000,
		} );
		const download = getDownloadRequests().filter(
			( r ) => r.path === '/downloads/cat.jpg'
		);
		expect( download.length ).toBeGreaterThan( 0 );
		expect( download.every( ( r ) => r.authorization === undefined ) ).toBe(
			true
		);
	} );

	it( 'names the file from Content-Type, Content-Disposition, or a redirect target', async () => {
		const names: Record< string, string > = {
			noext: 'noext.png',
			disp: 'named.png',
			redirect: 'redirect.jpg',
		};
		for ( const [ route, expected ] of Object.entries( names ) ) {
			const result = await run( [
				'wp/v2',
				'media',
				'create',
				`--file=${ fixture.baseUrl }/downloads/${ route }`,
			] );
			expect( result.exitCode ).toBe( 0 );
			expect( lastUpload().files[ 0 ]?.name ).toBe( expected );
		}
	} );

	it( 'reports a failed download and continues with the rest of a mixed batch', async () => {
		const local = await makeFile( 'mixed.png' );
		const result = await run( [
			'wp/v2',
			'media',
			'create',
			`--file=@${ fixture.baseUrl }/downloads/missing.jpg`,
			`--file=${ local }`,
			'--format=ids',
		] );
		expect( result.exitCode ).toBe( 1 );
		expect( result.stderr ).toContain( 'Unable to download' );
		expect( result.stderr ).toContain( 'HTTP 404' );
		expect( result.stdout.trim().split( /\s+/ ) ).toHaveLength( 1 );
	} );

	it( 'keeps stdout clean while downloading without a TTY (the progress bar only draws on a terminal)', async () => {
		const result = await runCli( [
			'wp/v2',
			'media',
			'create',
			`--file=@${ fixture.baseUrl }/downloads/cat.jpg`,
			`--url=${ fixture.baseUrl }`,
			'--format=ids',
			'--no-color',
		] );
		expect( result.exitCode ).toBe( 0 );
		expect( result.stdout.trim() ).toMatch( /^\d+$/ );
	} );
} );
