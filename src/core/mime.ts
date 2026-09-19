/**
 * External dependencies
 */
import path from 'node:path';

/** File extension (lowercase, no dot) to MIME type, for the types people actually upload. */
const MIME_BY_EXTENSION: Record< string, string > = {
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	jpe: 'image/jpeg',
	png: 'image/png',
	gif: 'image/gif',
	webp: 'image/webp',
	avif: 'image/avif',
	heic: 'image/heic',
	heif: 'image/heif',
	bmp: 'image/bmp',
	tif: 'image/tiff',
	tiff: 'image/tiff',
	svg: 'image/svg+xml',
	ico: 'image/x-icon',
	pdf: 'application/pdf',
	doc: 'application/msword',
	docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	xls: 'application/vnd.ms-excel',
	xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	ppt: 'application/vnd.ms-powerpoint',
	pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
	odt: 'application/vnd.oasis.opendocument.text',
	txt: 'text/plain',
	csv: 'text/csv',
	json: 'application/json',
	xml: 'application/xml',
	zip: 'application/zip',
	mp3: 'audio/mpeg',
	m4a: 'audio/mp4',
	wav: 'audio/wav',
	ogg: 'audio/ogg',
	mp4: 'video/mp4',
	mov: 'video/quicktime',
	webm: 'video/webm',
	avi: 'video/avi',
	mkv: 'video/x-matroska',
};

/** Fallback type when nothing better is known; the server re-checks the file itself anyway. */
export const DEFAULT_MIME_TYPE = 'application/octet-stream';

/**
 * A filename's extension, lowercased and without the dot.
 * @param filename The filename.
 * @return The extension, or an empty string when there is none.
 */
export function extensionOf( filename: string ): string {
	return path.extname( filename ).slice( 1 ).toLowerCase();
}

/**
 * Guesses a MIME type from a filename's extension.
 * @param filename The filename.
 * @return The MIME type, or `application/octet-stream` when unknown.
 */
export function mimeForFilename( filename: string ): string {
	return MIME_BY_EXTENSION[ extensionOf( filename ) ] ?? DEFAULT_MIME_TYPE;
}

/**
 * The preferred file extension for a MIME type (the inverse of {@link mimeForFilename}).
 * @param mime A MIME type, possibly with parameters (`image/png; charset=binary`).
 * @return The extension without a dot, or undefined when unknown.
 */
export function extensionForMime( mime: string ): string | undefined {
	const bare = mime.split( ';' )[ 0 ]?.trim().toLowerCase();
	return Object.keys( MIME_BY_EXTENSION ).find(
		( ext ) => MIME_BY_EXTENSION[ ext ] === bare
	);
}
