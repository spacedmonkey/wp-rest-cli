import { resolveApiRoot } from '../core/discovery.js';
import { WpRestClient } from '../core/client.js';
import { BasicAuthProvider } from '../core/auth/basic.js';
import {
  fetchIndex,
  routesForNamespace,
  resolveRouteInfo,
  supportedVerbsForRoute,
  isApplicationPasswordsSupported,
} from '../core/indexer.js';
import { introspectRoute, supportedContexts } from '../core/introspect.js';
import { buildVerbRequest } from '../core/verbs.js';
import { formatOutput } from '../core/formatter.js';
import { withSpinner, pc } from '../ui.js';
import { CliError, WpApiError } from '../core/errors.js';
import {
  META_VERBS,
  parseMetaArgs,
  runMetaCommand,
  printMetaUsage,
  printMetaVerbHelp,
  routeSupportsMeta,
  type MetaVerb,
  type ParsedMeta,
} from './meta.js';
import type { GlobalFlags, RouteEndpoint, RouteSchema, Verb } from '../types.js';

const VERBS: Verb[] = ['list', 'get', 'create', 'update', 'delete', 'exists', 'generate'];
const META_KEYWORD = 'meta';

export type ParsedCommand =
  | { mode: 'namespaces' }
  | { mode: 'routes'; namespace: string }
  | { mode: 'introspect'; namespace: string; route: string }
  | { mode: 'meta-usage'; namespace: string; route: string }
  | { mode: 'meta'; namespace: string; route: string; meta: ParsedMeta }
  | {
      mode: 'verb';
      namespace: string;
      route: string;
      verb: Verb;
      id?: string;
      fields: Record<string, string>;
    };

function isFieldToken(token: string): boolean {
  return token.includes('=');
}

function parseFields(tokens: string[]): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const token of tokens) {
    const eq = token.indexOf('=');
    if (eq === -1) {
      throw new CliError(`Expected a field=value argument, got "${token}".`);
    }
    fields[token.slice(0, eq)] = token.slice(eq + 1);
  }
  return fields;
}

/**
 * Consumes leading tokens as route segments (joined with "/") up to — but not
 * including — the first token that's a recognised verb. This lets a route
 * that WordPress itself nests under several literal path segments (e.g.
 * WP_REST_Global_Styles_Controller's `global-styles/themes/(?P<stylesheet>%s)`)
 * be addressed the same way WP-CLI addresses nested commands — as separate
 * words — rather than requiring one pre-joined "global-styles/themes" token:
 *   wp-rest-cli wp/v2 global-styles themes get <stylesheet>
 * A token that reaches this loop can't yet be distinguished from a genuine
 * (if unusual) route segment, so an unrecognised verb is no longer rejected
 * up front here — it's folded into the route and left to fail naturally
 * against the live API (see the introspect/verb handling below).
 */
function consumeRouteSegments(tokens: string[]): { route: string; rest: string[] } {
  const segments: string[] = [];
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index] as string;
    if (VERBS.includes(token as Verb) || token === META_KEYWORD || isFieldToken(token)) break;
    segments.push(token);
    index++;
  }
  return { route: segments.join('/'), rest: tokens.slice(index) };
}

export function parseCommandArgs(args: string[]): ParsedCommand {
  const [namespace, ...tail] = args;
  if (!namespace) return { mode: 'namespaces' };

  const { route, rest } = consumeRouteSegments(tail);
  if (!route) return { mode: 'routes', namespace };

  const [verbToken, ...verbRest] = rest;
  if (!verbToken) return { mode: 'introspect', namespace, route };
  if (verbToken === META_KEYWORD) {
    const [metaVerbToken, ...metaRest] = verbRest;
    if (!metaVerbToken) return { mode: 'meta-usage', namespace, route };
    return { mode: 'meta', namespace, route, meta: parseMetaArgs(metaVerbToken, metaRest) };
  }
  if (isFieldToken(verbToken)) {
    throw new CliError(`Expected a verb (${VERBS.join(', ')}) before "${verbToken}".`);
  }
  const verb = verbToken as Verb;

  if (verb === 'get' || verb === 'update' || verb === 'delete' || verb === 'exists') {
    const [id, ...fieldTokens] = verbRest;
    if (!id || isFieldToken(id)) {
      throw new CliError(`"${verb}" requires an <id> as its first argument.`);
    }
    return { mode: 'verb', namespace, route, verb, id, fields: parseFields(fieldTokens) };
  }

  return { mode: 'verb', namespace, route, verb, fields: parseFields(verbRest) };
}

export type ParsedHelp =
  | { mode: 'namespace'; namespace: string }
  | { mode: 'route'; namespace: string; route: string }
  | { mode: 'verb'; namespace: string; route: string; verb: Verb }
  | { mode: 'meta-usage'; namespace: string; route: string }
  | { mode: 'meta-verb'; namespace: string; route: string; metaVerb: MetaVerb };

export function parseHelpArgs(args: string[]): ParsedHelp {
  const [namespace, ...tail] = args;
  if (!namespace) {
    throw new CliError('Usage: wp-rest-cli help [<namespace> [<route...> [<verb>]]]');
  }

  const { route, rest } = consumeRouteSegments(tail);
  if (!route) return { mode: 'namespace', namespace };

  const [verbToken] = rest;
  if (!verbToken) return { mode: 'route', namespace, route };
  if (verbToken === META_KEYWORD) {
    const [metaVerbToken] = rest.slice(1);
    if (!metaVerbToken) return { mode: 'meta-usage', namespace, route };
    if (!META_VERBS.includes(metaVerbToken as MetaVerb)) {
      throw new CliError(
        `Unknown meta command "${metaVerbToken}". Expected one of: ${META_VERBS.join(', ')}.`,
      );
    }
    return { mode: 'meta-verb', namespace, route, metaVerb: metaVerbToken as MetaVerb };
  }
  if (isFieldToken(verbToken)) {
    throw new CliError(`Expected a verb (${VERBS.join(', ')}) before "${verbToken}".`);
  }
  return { mode: 'verb', namespace, route, verb: verbToken as Verb };
}

function buildAuth(flags: GlobalFlags): BasicAuthProvider | undefined {
  const username = flags.username ?? process.env.WP_USERNAME;
  const password = flags.password ?? process.env.WP_PASSWORD;
  if (!username || !password) return undefined;
  return new BasicAuthProvider(username, password);
}

function resolveContent(raw: string | undefined): unknown {
  if (raw === undefined) return undefined;
  if (raw.startsWith('@')) {
    throw new CliError(
      'Reading --content from a file (@path) is not supported in this environment; pass inline JSON instead.',
    );
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new CliError(`--content must be valid JSON: ${raw}`);
  }
}

function formatEndpointArgs(endpoint: RouteEndpoint): string[] {
  const args = endpoint.args ?? {};
  const names = Object.keys(args);
  if (names.length === 0) return ['    (no arguments)'];
  const lines: string[] = [];
  for (const name of names) {
    const arg = args[name];
    if (!arg) continue;
    const required = arg.required ? pc.red('required') : 'optional';
    const type = Array.isArray(arg.type) ? arg.type.join('|') : (arg.type ?? 'any');
    const enumSuffix = arg.enum ? ` enum(${arg.enum.join(',')})` : '';
    const defaultSuffix =
      arg.default !== undefined ? ` default(${JSON.stringify(arg.default)})` : '';
    lines.push(
      `    --${name}=<${type}>${enumSuffix}${defaultSuffix} [${required}]` +
        (arg.description ? ` — ${arg.description}` : ''),
    );
  }
  return lines;
}

function printIntrospection(namespace: string, route: string, endpoints: RouteEndpoint[]): string {
  const lines: string[] = [pc.bold(`${namespace}/${route}`)];
  for (const endpoint of endpoints) {
    lines.push('');
    lines.push(pc.cyan(`  ${endpoint.methods.join(', ')}`));
    lines.push(...formatEndpointArgs(endpoint));
  }
  return lines.join('\n');
}

// 'list' and 'create' map directly onto this route's *collection* endpoint
// (GET/POST on <namespace>/<route>), so their real argument schema is
// available from introspecting that URL. 'update' (PUT on the item URL
// <namespace>/<route>/<id>) has no schema of its own here — WordPress
// controllers generally accept the same writable fields for update as for
// create, so it borrows the create (POST) schema as the closest available
// approximation; 'generate' (which just calls create repeatedly) borrows it
// for the same reason. 'get', 'delete' and 'exists' have no useful schema to
// show either way.
const COLLECTION_VERB_METHOD: Partial<Record<Verb, string>> = {
  list: 'GET',
  create: 'POST',
  update: 'POST',
  generate: 'POST',
};

/** Renders an endpoint's args WP-CLI-synopsis-style: `[--name=<name>]`, or bare `--name=<name>` if required. */
function formatArgsInline(args: RouteEndpoint['args']): string {
  if (!args) return '';
  return Object.keys(args)
    .map((name) => (args[name]?.required ? `--${name}=<${name}>` : `[--${name}=<${name}>]`))
    .join(' ');
}

/** A single WP-CLI-style synopsis line for one verb, e.g. `wp-rest-cli wp/v2 posts create [--title=<title>] [--<field>=<value>]`. */
function buildVerbSynopsis(
  namespace: string,
  route: string,
  verb: Verb,
  endpoints: RouteEndpoint[],
): string {
  const base = `wp-rest-cli ${namespace} ${route} ${verb}`;
  const method = COLLECTION_VERB_METHOD[verb];
  const endpoint = method ? endpoints.find((e) => e.methods.includes(method)) : undefined;
  const inlineArgs = formatArgsInline(endpoint?.args);

  switch (verb) {
    case 'list':
      return [base, inlineArgs].filter(Boolean).join(' ');
    case 'get':
      return `${base} <id> [--context=<context>]`;
    case 'create':
      return [base, inlineArgs, '[--<field>=<value>]'].filter(Boolean).join(' ');
    case 'update':
      return [`${base} <id>`, inlineArgs, '[--<field>=<value>]'].filter(Boolean).join(' ');
    case 'delete':
      return `${base} <id> [--force]`;
    case 'exists':
      return `${base} <id>`;
    case 'generate':
      return [base, '[--count=<count>]', inlineArgs, '[--<field>=<value>]']
        .filter(Boolean)
        .join(' ');
  }
}

/**
 * A `usage: ... \n   or: ... ` block, matching `wp help <command>`'s synopsis
 * style — one line per verb this route actually supports (`supportedVerbs`,
 * from `supportedVerbsForRoute`). Filtering matters: a singleton resource
 * like `wp/v2/settings` has no addressable `<id>` at all, so unconditionally
 * offering `get <id>`/`update <id>`/`delete <id>`/`exists <id>` would send
 * users straight into a 404 that has nothing to do with a missing item.
 */
function printRouteUsage(
  namespace: string,
  route: string,
  endpoints: RouteEndpoint[],
  supportedVerbs: Verb[],
): string {
  return VERBS.filter((verb) => supportedVerbs.includes(verb))
    .map(
      (verb, i) =>
        (i === 0 ? 'usage: ' : '   or: ') + buildVerbSynopsis(namespace, route, verb, endpoints),
    )
    .join('\n');
}

function printVerbHelp(
  namespace: string,
  route: string,
  verb: Verb,
  endpoints: RouteEndpoint[],
  supportedVerbs: Verb[],
): string {
  const lines: string[] = [
    pc.bold(`${namespace}/${route} ${verb}`),
    '',
    `  usage: ${buildVerbSynopsis(namespace, route, verb, endpoints)}`,
  ];

  if (!supportedVerbs.includes(verb)) {
    lines.push(
      '',
      pc.red(
        `  Warning: ${namespace}/${route} doesn't appear to support "${verb}" — its registered ` +
          `methods are: ${supportedVerbs.length ? supportedVerbs.join(', ') : '(none detected)'}.`,
      ),
    );
  }

  const method = COLLECTION_VERB_METHOD[verb];
  const endpoint = method ? endpoints.find((e) => e.methods.includes(method)) : undefined;
  if (endpoint) {
    const label =
      verb === 'update'
        ? `  ${method} ${namespace}/${route} accepts (same writable fields as create):`
        : verb === 'generate'
          ? `  ${method} ${namespace}/${route} accepts (same writable fields as create, applied to each item):`
          : `  ${method} ${namespace}/${route} accepts:`;
    lines.push('', pc.cyan(label));
    lines.push(...formatEndpointArgs(endpoint));
  } else {
    lines.push(
      '',
      pc.dim(
        `  This operates on a single item (${namespace}/${route}/<id>); its argument schema ` +
          `isn't exposed by the collection endpoint's OPTIONS response, but field=value pairs ` +
          `(if any) are still sent through as query parameters.`,
      ),
    );
  }
  if (verb === 'delete') {
    lines.push(
      '',
      pc.dim('  Pass --force to bypass trash and permanently delete, where supported.'),
    );
  }
  if (verb === 'exists') {
    lines.push(
      '',
      pc.dim(
        '  Exits 0 if a GET for <id> succeeds, 1 if it 404s; prints nothing else in table format.',
      ),
    );
  }
  if (verb === 'generate') {
    lines.push(
      '',
      pc.dim(
        '  Pass --count=<n> to create that many items (default 1); the same fields are reused for every one.',
      ),
    );
  }
  return lines.join('\n');
}

/**
 * Fetches a route's schema for introspection/help. A route that only exists
 * in parameterised form (see `resolveRouteInfo`) can't be reached with a live
 * OPTIONS request on its bare path — that path never matches the route's
 * regex without a value in place of the parameter — so its schema is read
 * from the already-fetched site index instead.
 */
async function getRouteSchema(
  client: WpRestClient,
  apiRoot: string,
  namespace: string,
  route: string,
  showSpinner: boolean,
): Promise<{ schema: RouteSchema; requiresParam: boolean; verbs: Verb[] }> {
  const index = await withSpinner('Fetching API index', showSpinner, () =>
    fetchIndex(client, apiRoot),
  );
  const info = resolveRouteInfo(index, namespace, route);
  const verbs = supportedVerbsForRoute(index, info.path);
  if (info.requiresParam) {
    // info.path came from resolveRouteInfo enumerating index.routes' own keys.
    return { schema: index.routes[info.path] as RouteSchema, requiresParam: true, verbs };
  }
  const routeUrl = new URL(`${namespace}/${route}`, apiRoot).toString();
  const schema = await withSpinner(`Introspecting ${namespace}/${route}`, showSpinner, () =>
    introspectRoute(client, routeUrl),
  );
  return { schema, requiresParam: false, verbs };
}

/** Combines the WP-CLI-style usage synopsis with the existing detailed per-method arg listing. */
function renderRouteHelp(
  namespace: string,
  route: string,
  schema: RouteSchema,
  requiresParam: boolean,
  verbs: Verb[],
): string {
  const endpoints = schema.endpoints ?? [];
  const contexts = supportedContexts(schema);
  const metaUsage = routeSupportsMeta(endpoints) ? '\n\n' + printMetaUsage(namespace, route) : '';
  const paramNote = requiresParam
    ? pc.dim(
        `\nThis route only exists with a value in place of its URL parameter, e.g.:\n` +
          `  wp-rest-cli ${namespace} ${route} get <value>\n`,
      )
    : '';
  const noIdNote =
    !requiresParam && !verbs.some((v) => v === 'get' || v === 'update' || v === 'delete')
      ? pc.dim(
          `\nThis route has no addressable <id> (it's a single/settings-style resource) — ` +
            `read and write it directly via 'list'/'create' on ${namespace}/${route}.\n`,
        )
      : '';
  const contextNote = contexts.length
    ? pc.dim(`\nSupported --context values: ${contexts.join(', ')}\n`)
    : '';
  return (
    printRouteUsage(namespace, route, endpoints, verbs) +
    metaUsage +
    paramNote +
    noIdNote +
    contextNote +
    '\n\n' +
    printIntrospection(namespace, route, endpoints)
  );
}

export async function runRestCommand(
  parsed: ParsedCommand,
  flags: GlobalFlags,
  siteUrl: string,
): Promise<{ output: string; exitCode: number }> {
  const client = new WpRestClient(buildAuth(flags), flags.debug);

  const apiRoot = await withSpinner('Discovering REST API', !flags.quiet, () =>
    resolveApiRoot(siteUrl, flags.debug),
  );

  if (parsed.mode === 'namespaces') {
    const index = await withSpinner('Fetching API index', !flags.quiet, () =>
      fetchIndex(client, apiRoot),
    );
    const rows = index.namespaces.map((namespace) => ({ namespace }));
    const output = await formatOutput(rows, {
      format: flags.format,
      fields: flags.fields,
      field: flags.field,
      color: flags.color,
    });
    const note = isApplicationPasswordsSupported(index)
      ? pc.dim('\nApplication Passwords are supported on this site.')
      : pc.dim('\nApplication Passwords do not appear to be supported on this site.');
    return { output: output + (flags.format === 'table' ? note : ''), exitCode: 0 };
  }

  if (parsed.mode === 'routes') {
    const index = await withSpinner('Fetching API index', !flags.quiet, () =>
      fetchIndex(client, apiRoot),
    );
    const rows = routesForNamespace(index, parsed.namespace).map(({ route, path }) => ({
      route,
      verbs: supportedVerbsForRoute(index, path).join(', '),
    }));
    const output = await formatOutput(rows, {
      format: flags.format,
      fields: flags.fields,
      field: flags.field,
      color: flags.color,
    });
    return { output, exitCode: 0 };
  }

  if (parsed.mode === 'introspect') {
    const { schema, requiresParam, verbs } = await getRouteSchema(
      client,
      apiRoot,
      parsed.namespace,
      parsed.route,
      !flags.quiet,
    );
    if (flags.format !== 'table') {
      const output = await formatOutput(schema, {
        format: flags.format,
        fields: flags.fields,
        field: flags.field,
        color: flags.color,
      });
      return { output, exitCode: 0 };
    }
    return {
      output: renderRouteHelp(parsed.namespace, parsed.route, schema, requiresParam, verbs),
      exitCode: 0,
    };
  }

  if (parsed.mode === 'meta-usage') {
    return { output: printMetaUsage(parsed.namespace, parsed.route), exitCode: 0 };
  }

  if (parsed.mode === 'meta') {
    return runMetaCommand(parsed.meta, client, apiRoot, parsed.namespace, parsed.route, flags);
  }

  if (parsed.verb === 'exists') {
    const request = buildVerbRequest({
      verb: 'exists',
      apiRoot,
      namespace: parsed.namespace,
      route: parsed.route,
      id: parsed.id,
      context: flags.context,
      fields: parsed.fields,
    });
    let exists = true;
    try {
      await withSpinner(`GET ${parsed.namespace}/${parsed.route}`, !flags.quiet, () =>
        client.request(request.url, { method: request.method }),
      );
    } catch (error) {
      if (error instanceof WpApiError && error.status === 404) {
        exists = false;
      } else {
        throw error;
      }
    }
    if (flags.format === 'table' && !flags.field && !flags.fields) {
      return {
        output: exists
          ? pc.green(`Success: ${parsed.route} ${parsed.id} exists.`)
          : pc.dim(`${parsed.route} ${parsed.id} does not exist.`),
        exitCode: exists ? 0 : 1,
      };
    }
    const output = await formatOutput(
      { exists },
      { format: flags.format, fields: flags.fields, field: flags.field, color: flags.color },
    );
    return { output, exitCode: exists ? 0 : 1 };
  }

  if (parsed.verb === 'generate') {
    const { count: countRaw, ...createFields } = parsed.fields;
    const count = countRaw !== undefined ? Number(countRaw) : 1;
    if (!Number.isInteger(count) || count < 1) {
      throw new CliError(`--count must be a positive integer, got "${countRaw}".`);
    }
    const created: unknown[] = [];
    for (let i = 0; i < count; i++) {
      const request = buildVerbRequest({
        verb: 'create',
        apiRoot,
        namespace: parsed.namespace,
        route: parsed.route,
        context: flags.context,
        fields: createFields,
        content: resolveContent(flags.content),
      });
      const { body } = await withSpinner(
        `POST ${parsed.namespace}/${parsed.route} (${i + 1}/${count})`,
        !flags.quiet,
        () => client.request(request.url, { method: request.method, body: request.body }),
      );
      created.push(body);
    }
    if (flags.format === 'table' && !flags.field && !flags.fields) {
      const ids = created.map((r) => (r as { id?: unknown } | undefined)?.id ?? '').join(' ');
      return {
        output: pc.green(`Success: created ${count} ${parsed.route}: ${ids}`.trim()),
        exitCode: 0,
      };
    }
    const output = await formatOutput(created, {
      format: flags.format,
      fields: flags.fields,
      field: flags.field,
      color: flags.color,
    });
    return { output, exitCode: 0 };
  }

  // parsed.mode === 'verb', parsed.verb is now one of list/get/create/update/delete
  const request = buildVerbRequest({
    verb: parsed.verb,
    apiRoot,
    namespace: parsed.namespace,
    route: parsed.route,
    id: parsed.id,
    context: flags.context,
    fields: parsed.fields,
    content: resolveContent(flags.content),
  });

  const { body } = await withSpinner(
    `${request.method} ${parsed.namespace}/${parsed.route}`,
    !flags.quiet,
    () => client.request(request.url, { method: request.method, body: request.body }),
  );

  if (parsed.verb === 'create' || parsed.verb === 'update' || parsed.verb === 'delete') {
    const record = body as { id?: number | string } | undefined;
    const verbLabel = { create: 'Created', update: 'Updated', delete: 'Deleted' }[parsed.verb];
    const idLabel = record?.id ?? parsed.id ?? '';
    if (flags.format === 'table' && !flags.field && !flags.fields) {
      return {
        output: pc.green(`Success: ${verbLabel} ${parsed.route} ${idLabel}.`.trim()),
        exitCode: 0,
      };
    }
  }

  const output = await formatOutput(body, {
    format: flags.format,
    fields: flags.fields,
    field: flags.field,
    color: flags.color,
  });
  return { output, exitCode: 0 };
}

/**
 * Read-only help lookups, mirroring `wp help <command>...`: shows routes for a
 * namespace, a route's full schema, or (given a verb) just that verb's calling
 * convention and matching argument schema — never performs the verb's request.
 */
export async function runHelpCommand(
  parsed: ParsedHelp,
  flags: GlobalFlags,
  siteUrl: string,
): Promise<{ output: string; exitCode: number }> {
  const client = new WpRestClient(buildAuth(flags), flags.debug);
  const apiRoot = await withSpinner('Discovering REST API', !flags.quiet, () =>
    resolveApiRoot(siteUrl, flags.debug),
  );

  if (parsed.mode === 'namespace') {
    const index = await withSpinner('Fetching API index', !flags.quiet, () =>
      fetchIndex(client, apiRoot),
    );
    const rows = routesForNamespace(index, parsed.namespace).map(({ route, path }) => ({
      route,
      verbs: supportedVerbsForRoute(index, path).join(', '),
    }));
    const output = await formatOutput(rows, {
      format: flags.format,
      fields: flags.fields,
      field: flags.field,
      color: flags.color,
    });
    return { output, exitCode: 0 };
  }

  if (parsed.mode === 'meta-usage') {
    return { output: printMetaUsage(parsed.namespace, parsed.route), exitCode: 0 };
  }

  if (parsed.mode === 'meta-verb') {
    return {
      output: printMetaVerbHelp(parsed.namespace, parsed.route, parsed.metaVerb),
      exitCode: 0,
    };
  }

  const { schema, requiresParam, verbs } = await getRouteSchema(
    client,
    apiRoot,
    parsed.namespace,
    parsed.route,
    !flags.quiet,
  );

  if (parsed.mode === 'route') {
    return {
      output: renderRouteHelp(parsed.namespace, parsed.route, schema, requiresParam, verbs),
      exitCode: 0,
    };
  }

  // parsed.mode === 'verb'
  return {
    output: printVerbHelp(parsed.namespace, parsed.route, parsed.verb, schema.endpoints ?? [], verbs),
    exitCode: 0,
  };
}
