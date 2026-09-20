/**
 * WordPress dependencies
 */
import { addQueryArgs } from '@wordpress/url';

/**
 * Internal dependencies
 */
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
	/**
	 * Where in `route.split('/')` the id belongs, for a route whose URL
	 * parameter isn't at the very end (e.g. `posts/(?P<parent>[\d]+)/revisions`
	 * — see `resolveRouteInfo`). Defaults to the end of the route (today's
	 * only supported shape) when omitted.
	 */
	paramIndex?: number;
	context: Context;
	/**
	 * Parsed `field=value` CLI arguments. Values are usually raw strings, but
	 * a field the route's live schema declares `object`/`array`-typed (e.g.
	 * `meta`) may already be parsed JSON (see `core/validate.ts`'s
	 * `coerceJsonFields`) by the time it reaches here.
	 */
	fields: Record< string, unknown >;
	/** Raw JSON body override for create/update, from --body. */
	bodyOverride?: unknown;
	/**
	 * `--fields` value, forwarded as the API's `_fields` so it can trim the
	 * response server-side (output is still filtered locally too, since some
	 * endpoints ignore it). Not sent on `delete`, whose response is wrapped
	 * in `{deleted, previous}` and would be stripped by a top-level filter.
	 */
	responseFields?: string;
}

/**
 * Splices an id into a route's segments at `paramIndex`, defaulting to the
 * end of the route when `paramIndex` isn't given.
 * @param route      The namespace-relative route, `/`-joined.
 * @param id         The id to splice in.
 * @param paramIndex Where within `route.split('/')` to insert it.
 * @return The route with the (URI-encoded) id inserted.
 */
function spliceId( route: string, id: string, paramIndex?: number ): string {
	const segments = route.split( '/' );
	const insertAt = paramIndex ?? segments.length;
	segments.splice( insertAt, 0, encodeURIComponent( id ) );
	return segments.join( '/' );
}

/**
 * Maps a single-request verb plus id/fields/content into the concrete
 * `{method, url, body}` needed to issue it.
 * @param options The verb and its arguments.
 * @return The request to issue.
 */
export function buildVerbRequest( options: BuildRequestOptions ): VerbRequest {
	const {
		verb,
		apiRoot,
		namespace,
		route,
		id,
		paramIndex,
		context,
		fields,
		bodyOverride,
		responseFields,
	} = options;

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
		? new URL(
				`${ namespace }/${ spliceId( route, id, paramIndex ) }`,
				apiRoot
		  ).toString()
		: collectionUrl;
	const method = METHOD_BY_VERB[ verb ];

	// Top-level keys only (dotted paths are selected locally; older cores
	// mishandle nested `_fields`), plus `id` so `--format=ids` keeps working.
	const apiFields = responseFields
		? [
				...new Set( [
					'id',
					...responseFields
						.split( ',' )
						.map( ( f ) => f.trim().split( '.' )[ 0 ] )
						.filter( Boolean ),
				] ),
		  ].join( ',' )
		: undefined;
	const withFields = ( url: string ) =>
		apiFields ? addQueryArgs( url, { _fields: apiFields } ) : url;

	switch ( verb ) {
		case 'list':
			return {
				method,
				url: withFields(
					addQueryArgs( collectionUrl, { context, ...fields } )
				),
			};
		case 'get':
		case 'exists':
			return {
				method,
				url: withFields(
					addQueryArgs( singularUrl, { context, ...fields } )
				),
			};
		case 'delete':
			return { method, url: addQueryArgs( singularUrl, fields ) };
		case 'create':
			return {
				method,
				url: withFields( collectionUrl ),
				body: resolveBody( fields, bodyOverride ),
			};
		case 'update':
			return {
				method,
				url: withFields( singularUrl ),
				body: resolveBody( fields, bodyOverride ),
			};
	}
}

/**
 * Merges `--body`'s parsed JSON object with `field=value` overrides, or
 * falls back to just the fields when there's no `--body`.
 * @param fields       Parsed `field=value` CLI arguments.
 * @param bodyOverride Parsed `--body` value, if given.
 * @return The request body to send.
 */
function resolveBody(
	fields: Record< string, unknown >,
	bodyOverride: unknown
): Record< string, unknown > {
	if ( bodyOverride !== undefined ) {
		if ( typeof bodyOverride === 'object' && bodyOverride !== null ) {
			return {
				...( bodyOverride as Record< string, unknown > ),
				...fields,
			};
		}
		throw new CliError( '--body must resolve to a JSON object.' );
	}
	return fields;
}
