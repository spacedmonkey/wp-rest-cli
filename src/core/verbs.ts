import { addQueryArgs } from '@wordpress/url';
import { CliError } from './errors.js';
import type { Context, Verb } from '../types.js';

export interface VerbRequest {
	method: 'GET' | 'POST' | 'PUT' | 'DELETE';
	url: string;
	body?: Record< string, unknown >;
}

/**
 * 'generate' isn't a single HTTP request — it's the CLI calling 'create'
 * repeatedly (see runRestCommand) — so it's excluded here rather than given
 * a (meaningless) request shape of its own.
 */
export type SingleRequestVerb = Exclude< Verb, 'generate' >;

const METHOD_BY_VERB: Record< SingleRequestVerb, VerbRequest[ 'method' ] > = {
	list: 'GET',
	get: 'GET',
	create: 'POST',
	update: 'PUT',
	delete: 'DELETE',
	exists: 'GET',
};

const REQUIRES_ID: SingleRequestVerb[] = [
	'get',
	'update',
	'delete',
	'exists',
];

export interface BuildRequestOptions {
	verb: SingleRequestVerb;
	apiRoot: string;
	namespace: string;
	route: string;
	id?: string;
	context: Context;
	fields: Record< string, string >;
	/** Raw JSON body override for create/update, from --content. */
	content?: unknown;
}

/**
 * Maps a single-request verb plus id/fields/content into the concrete
 * `{method, url, body}` needed to issue it.
 * @param options The verb and its arguments.
 * @return The request to issue.
 */
export function buildVerbRequest( options: BuildRequestOptions ): VerbRequest {
	const { verb, apiRoot, namespace, route, id, context, fields, content } =
		options;

	if ( REQUIRES_ID.includes( verb ) && ! id ) {
		throw new CliError(
			`"${ verb }" requires an <id>, e.g. wp ${ namespace } ${ route } ${ verb } 42`
		);
	}

	const collectionUrl = new URL(
		`${ namespace }/${ route }`,
		apiRoot
	).toString();
	const singularUrl = id
		? `${ collectionUrl }/${ encodeURIComponent( id ) }`
		: collectionUrl;
	const method = METHOD_BY_VERB[ verb ];

	switch ( verb ) {
		case 'list':
			return {
				method,
				url: addQueryArgs( collectionUrl, { context, ...fields } ),
			};
		case 'get':
		case 'exists':
			return {
				method,
				url: addQueryArgs( singularUrl, { context, ...fields } ),
			};
		case 'delete':
			return { method, url: addQueryArgs( singularUrl, fields ) };
		case 'create':
			return {
				method,
				url: collectionUrl,
				body: resolveBody( fields, content ),
			};
		case 'update':
			return {
				method,
				url: singularUrl,
				body: resolveBody( fields, content ),
			};
	}
}

/**
 * Merges `--content`'s parsed JSON object with `field=value` overrides, or
 * falls back to just the fields when there's no `--content`.
 * @param fields  Parsed `field=value` CLI arguments.
 * @param content Parsed `--content` value, if given.
 * @return The request body to send.
 */
function resolveBody(
	fields: Record< string, string >,
	content: unknown
): Record< string, unknown > {
	if ( content !== undefined ) {
		if ( typeof content === 'object' && content !== null ) {
			return { ...( content as Record< string, unknown > ), ...fields };
		}
		throw new CliError( '--content must resolve to a JSON object.' );
	}
	return fields;
}
