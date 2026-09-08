import type { WpRestClient } from '../core/client.js';
import { formatOutput } from '../core/formatter.js';
import { pc } from '../ui.js';
import { CliError } from '../core/errors.js';
import type { GlobalFlags, RouteEndpoint } from '../types.js';

/**
 * WP-CLI's `wp post meta <command>` talks to wp_postmeta directly, so it can
 * add repeated values under one key, enumerate every meta key regardless of
 * REST visibility, and so on. Over the REST API, meta only exists as the
 * `meta` object field on the parent resource (populated only for keys
 * registered with `show_in_rest`), read via GET and written by PATCHing that
 * resource with `{ meta: { ... } }`. Every command below is a best-effort
 * mapping onto that model — see each case in `runMetaCommand` for the
 * specific trade-off.
 */
export type MetaVerb =
  'add' | 'clean-duplicates' | 'delete' | 'get' | 'list' | 'patch' | 'pluck' | 'update';

export const META_VERBS: MetaVerb[] = [
  'add',
  'clean-duplicates',
  'delete',
  'get',
  'list',
  'patch',
  'pluck',
  'update',
];

export type ParsedMeta =
  | { metaVerb: 'list'; id: string; keys?: string[]; orderby?: string; order?: string }
  | { metaVerb: 'get'; id: string; key: string }
  | { metaVerb: 'add' | 'update'; id: string; key: string; value?: string }
  | { metaVerb: 'delete'; id: string; key?: string; value?: string; all: boolean }
  | { metaVerb: 'clean-duplicates'; id: string; key: string }
  | { metaVerb: 'pluck'; id: string; key: string; keyPath: string[] }
  | {
      metaVerb: 'patch';
      action: string;
      id: string;
      key: string;
      keyPath: string[];
      value?: string;
    };

const META_VERB_DESCRIPTIONS: Record<MetaVerb, string> = {
  add: 'Sets a meta value. REST has no separate "add" semantics for repeated values, so this behaves the same as `update`.',
  'clean-duplicates':
    'Removes duplicate entries from an array-type (multi-value) meta field; a single-value field has no duplicates to remove.',
  delete:
    'Deletes a whole meta key, or — given <value> too — removes every entry matching that value from an array-type field.',
  get: 'Reads a single meta key.',
  list: 'Lists every meta key visible on this item over the REST API (unregistered/non-REST meta is invisible here).',
  patch:
    'Modifies a nested value inside a (structured) meta field by key-path, without replacing the whole field.',
  pluck: 'Reads a nested value inside a (structured) meta field by key-path.',
  update: 'Sets a meta value.',
};

const META_VERB_SYNOPSES: Record<MetaVerb, (base: string) => string> = {
  add: (base) => `${base} add <id> <key> [<value>] [--format=<format>]`,
  'clean-duplicates': (base) => `${base} clean-duplicates <id> <key>`,
  delete: (base) => `${base} delete <id> [<key>] [<value>] [--all]`,
  get: (base) => `${base} get <id> <key> [--format=<format>]`,
  list: (base) =>
    `${base} list <id> [--keys=<keys>] [--format=<format>] [--orderby=<orderby>] [--order=<order>]`,
  patch: (base) => `${base} patch <action> <id> <key> <key-path>... [<value>] [--format=<format>]`,
  pluck: (base) => `${base} pluck <id> <key> <key-path>... [--format=<format>]`,
  update: (base) => `${base} update <id> <key> [<value>] [--format=<format>]`,
};

function metaBase(namespace: string, route: string): string {
  return `wp-rest-cli ${namespace} ${route} meta`;
}

/** A `usage: ... \n   or: ...` block covering every meta command, matching `wp help post meta`'s style. */
export function printMetaUsage(namespace: string, route: string): string {
  const base = metaBase(namespace, route);
  return META_VERBS.map(
    (verb, i) => (i === 0 ? 'usage: ' : '   or: ') + META_VERB_SYNOPSES[verb](base),
  ).join('\n');
}

export function printMetaVerbHelp(namespace: string, route: string, metaVerb: MetaVerb): string {
  const usage = META_VERB_SYNOPSES[metaVerb](metaBase(namespace, route));
  return [
    pc.bold(`${namespace}/${route} meta ${metaVerb}`),
    '',
    `  usage: ${usage}`,
    '',
    pc.dim(`  ${META_VERB_DESCRIPTIONS[metaVerb]}`),
  ].join('\n');
}

/** True if this route's create/update endpoint registers a `meta` field at all. */
export function routeSupportsMeta(endpoints: RouteEndpoint[]): boolean {
  return endpoints.some((endpoint) => endpoint.args && 'meta' in endpoint.args);
}

function isFieldToken(token: string): boolean {
  return token.includes('=');
}

function splitPositionalAndFlags(tokens: string[]): {
  positional: string[];
  flags: Record<string, string>;
} {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (const token of tokens) {
    if (!isFieldToken(token)) {
      positional.push(token);
      continue;
    }
    const eq = token.indexOf('=');
    flags[token.slice(0, eq)] = token.slice(eq + 1);
  }
  return { positional, flags };
}

export function parseMetaArgs(metaVerbToken: string, tokens: string[]): ParsedMeta {
  if (!META_VERBS.includes(metaVerbToken as MetaVerb)) {
    throw new CliError(
      `Unknown meta command "${metaVerbToken}". Expected one of: ${META_VERBS.join(', ')}.`,
    );
  }
  const metaVerb = metaVerbToken as MetaVerb;
  const { positional, flags } = splitPositionalAndFlags(tokens);

  switch (metaVerb) {
    case 'list': {
      const [id] = positional;
      if (!id) throw new CliError(META_VERB_SYNOPSES.list('Usage: <namespace> <route> meta'));
      return {
        metaVerb,
        id,
        keys: flags.keys
          ? flags.keys
              .split(',')
              .map((k) => k.trim())
              .filter(Boolean)
          : undefined,
        orderby: flags.orderby,
        order: flags.order,
      };
    }
    case 'get': {
      const [id, key] = positional;
      if (!id || !key)
        throw new CliError(META_VERB_SYNOPSES.get('Usage: <namespace> <route> meta'));
      return { metaVerb, id, key };
    }
    case 'add':
    case 'update': {
      const [id, key, value] = positional;
      if (!id || !key) {
        throw new CliError(META_VERB_SYNOPSES[metaVerb]('Usage: <namespace> <route> meta'));
      }
      return { metaVerb, id, key, value };
    }
    case 'delete': {
      const [id, key, value] = positional;
      if (!id) throw new CliError(META_VERB_SYNOPSES.delete('Usage: <namespace> <route> meta'));
      return { metaVerb, id, key, value, all: flags.all === 'true' };
    }
    case 'clean-duplicates': {
      const [id, key] = positional;
      if (!id || !key) {
        throw new CliError(
          META_VERB_SYNOPSES['clean-duplicates']('Usage: <namespace> <route> meta'),
        );
      }
      return { metaVerb, id, key };
    }
    case 'pluck': {
      const [id, key, ...keyPath] = positional;
      if (!id || !key || keyPath.length === 0) {
        throw new CliError(META_VERB_SYNOPSES.pluck('Usage: <namespace> <route> meta'));
      }
      return { metaVerb, id, key, keyPath };
    }
    case 'patch': {
      const [action, id, key, ...rest] = positional;
      if (!action || !id || !key || rest.length === 0) {
        throw new CliError(META_VERB_SYNOPSES.patch('Usage: <namespace> <route> meta'));
      }
      if (!['insert', 'update', 'delete'].includes(action)) {
        throw new CliError(
          `Unknown patch action "${action}". Expected one of: insert, update, delete.`,
        );
      }
      if (action === 'delete') {
        return { metaVerb, action, id, key, keyPath: rest };
      }
      if (rest.length < 2) {
        throw new CliError(
          `"meta patch ${action}" requires at least one <key-path> segment and a <value>.`,
        );
      }
      return {
        metaVerb,
        action,
        id,
        key,
        keyPath: rest.slice(0, -1),
        value: rest[rest.length - 1],
      };
    }
  }
}

function parseMetaValue(raw: string | undefined): unknown {
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function toIndex(segment: string): number | undefined {
  return /^\d+$/.test(segment) ? Number(segment) : undefined;
}

function getAtPath(value: unknown, path: string[]): unknown {
  let current = value;
  for (const segment of path) {
    if (current === undefined || current === null) return undefined;
    if (Array.isArray(current)) {
      const index = toIndex(segment);
      current = index === undefined ? undefined : current[index];
    } else if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

function cloneContainer(value: unknown): Record<string, unknown> | unknown[] {
  if (Array.isArray(value)) return [...value];
  if (value && typeof value === 'object') return { ...(value as Record<string, unknown>) };
  return {};
}

function setAtPath(root: unknown, path: string[], value: unknown): unknown {
  if (path.length === 0) return value;
  const head = path[0] as string;
  const tail = path.slice(1);
  const container = cloneContainer(root);
  if (Array.isArray(container)) {
    const index = toIndex(head) ?? container.length;
    container[index] = tail.length === 0 ? value : setAtPath(container[index], tail, value);
  } else {
    container[head] = tail.length === 0 ? value : setAtPath(container[head], tail, value);
  }
  return container;
}

function deleteAtPath(root: unknown, path: string[]): unknown {
  if (path.length === 0) return root;
  const head = path[0] as string;
  const tail = path.slice(1);
  const container = cloneContainer(root);
  if (Array.isArray(container)) {
    const index = toIndex(head);
    if (index === undefined) return container;
    if (tail.length === 0) container.splice(index, 1);
    else container[index] = deleteAtPath(container[index], tail);
  } else {
    if (tail.length === 0) delete container[head];
    else container[head] = deleteAtPath(container[head], tail);
  }
  return container;
}

/** "insert" semantics: append the value to the array found at `path` (creating it if absent). */
function insertAtPath(root: unknown, path: string[], value: unknown): unknown {
  const target = getAtPath(root, path);
  const nextArray = Array.isArray(target) ? [...target, value] : [value];
  return setAtPath(root, path, nextArray);
}

async function getItem(
  client: WpRestClient,
  apiRoot: string,
  namespace: string,
  route: string,
  id: string,
  context: GlobalFlags['context'],
): Promise<Record<string, unknown>> {
  const url = new URL(`${namespace}/${route}/${encodeURIComponent(id)}`, apiRoot).toString();
  const { body } = await client.request<Record<string, unknown>>(url, {
    method: 'GET',
    query: { context },
  });
  return body;
}

async function patchMeta(
  client: WpRestClient,
  apiRoot: string,
  namespace: string,
  route: string,
  id: string,
  meta: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const url = new URL(`${namespace}/${route}/${encodeURIComponent(id)}`, apiRoot).toString();
  const { body } = await client.request<Record<string, unknown>>(url, {
    method: 'PUT',
    body: { meta },
  });
  return body;
}

function getMetaObject(
  item: Record<string, unknown>,
  namespace: string,
  route: string,
): Record<string, unknown> {
  const meta = item.meta;
  if (!meta || typeof meta !== 'object') {
    throw new CliError(
      `${namespace}/${route} items have no "meta" field over the REST API — meta commands need ` +
        `a resource whose meta keys are registered with show_in_rest.`,
    );
  }
  return meta as Record<string, unknown>;
}

function renderValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

export async function runMetaCommand(
  parsed: ParsedMeta,
  client: WpRestClient,
  apiRoot: string,
  namespace: string,
  route: string,
  flags: GlobalFlags,
): Promise<{ output: string; exitCode: number }> {
  switch (parsed.metaVerb) {
    case 'list': {
      const item = await getItem(client, apiRoot, namespace, route, parsed.id, flags.context);
      const meta = getMetaObject(item, namespace, route);
      const keys = parsed.keys ?? Object.keys(meta);
      let rows = keys.map((key) => ({ key, value: meta[key] }));
      if (parsed.orderby) {
        const field = parsed.orderby === 'value' ? 'value' : 'key';
        rows = [...rows].sort((a, b) => String(a[field]).localeCompare(String(b[field])));
        if (parsed.order?.toLowerCase() === 'desc') rows.reverse();
      }
      const output = await formatOutput(rows, {
        format: flags.format,
        fields: flags.fields,
        field: flags.field,
        color: flags.color,
      });
      return { output, exitCode: 0 };
    }

    case 'get': {
      const item = await getItem(client, apiRoot, namespace, route, parsed.id, flags.context);
      const meta = getMetaObject(item, namespace, route);
      if (!(parsed.key in meta)) {
        throw new CliError(`No meta key "${parsed.key}" on ${namespace}/${route}/${parsed.id}.`);
      }
      return { output: renderValue(meta[parsed.key]), exitCode: 0 };
    }

    case 'add':
    case 'update': {
      await patchMeta(client, apiRoot, namespace, route, parsed.id, {
        [parsed.key]: parseMetaValue(parsed.value),
      });
      return {
        output: pc.green(`Success: set meta "${parsed.key}" on ${route} ${parsed.id}.`),
        exitCode: 0,
      };
    }

    case 'delete': {
      if (parsed.key === undefined) {
        if (!parsed.all) {
          throw new CliError(
            '"meta delete" requires a <key>, or pass --all to clear every REST-visible meta key.',
          );
        }
        const item = await getItem(client, apiRoot, namespace, route, parsed.id, flags.context);
        const meta = getMetaObject(item, namespace, route);
        const cleared = Object.fromEntries(Object.keys(meta).map((key) => [key, null]));
        await patchMeta(client, apiRoot, namespace, route, parsed.id, cleared);
        return {
          output: pc.green(`Success: deleted all meta on ${route} ${parsed.id}.`),
          exitCode: 0,
        };
      }

      if (parsed.value !== undefined) {
        const item = await getItem(client, apiRoot, namespace, route, parsed.id, flags.context);
        const meta = getMetaObject(item, namespace, route);
        const current = meta[parsed.key];
        if (!Array.isArray(current)) {
          throw new CliError(
            `Meta key "${parsed.key}" isn't a multi-value (array) field — omit <value> to delete the whole key.`,
          );
        }
        const target = parseMetaValue(parsed.value);
        const filtered = current.filter(
          (entry) => JSON.stringify(entry) !== JSON.stringify(target),
        );
        await patchMeta(client, apiRoot, namespace, route, parsed.id, { [parsed.key]: filtered });
        return {
          output: pc.green(
            `Success: removed ${current.length - filtered.length} matching value(s) from meta "${parsed.key}" on ${route} ${parsed.id}.`,
          ),
          exitCode: 0,
        };
      }

      await patchMeta(client, apiRoot, namespace, route, parsed.id, { [parsed.key]: null });
      return {
        output: pc.green(`Success: deleted meta "${parsed.key}" on ${route} ${parsed.id}.`),
        exitCode: 0,
      };
    }

    case 'clean-duplicates': {
      const item = await getItem(client, apiRoot, namespace, route, parsed.id, flags.context);
      const meta = getMetaObject(item, namespace, route);
      const current = meta[parsed.key];
      if (!Array.isArray(current)) {
        return {
          output: pc.dim(
            `Meta key "${parsed.key}" is single-value over REST — no duplicates possible.`,
          ),
          exitCode: 0,
        };
      }
      const seen = new Set<string>();
      const deduped = current.filter((entry) => {
        const key = JSON.stringify(entry);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      if (deduped.length === current.length) {
        return { output: pc.dim(`No duplicates found in meta "${parsed.key}".`), exitCode: 0 };
      }
      await patchMeta(client, apiRoot, namespace, route, parsed.id, { [parsed.key]: deduped });
      return {
        output: pc.green(
          `Success: removed ${current.length - deduped.length} duplicate value(s) from meta "${parsed.key}".`,
        ),
        exitCode: 0,
      };
    }

    case 'pluck': {
      const item = await getItem(client, apiRoot, namespace, route, parsed.id, flags.context);
      const meta = getMetaObject(item, namespace, route);
      return { output: renderValue(getAtPath(meta[parsed.key], parsed.keyPath)), exitCode: 0 };
    }

    case 'patch': {
      const item = await getItem(client, apiRoot, namespace, route, parsed.id, flags.context);
      const meta = getMetaObject(item, namespace, route);
      const current = meta[parsed.key];
      const updated =
        parsed.action === 'delete'
          ? deleteAtPath(current, parsed.keyPath)
          : parsed.action === 'insert'
            ? insertAtPath(current, parsed.keyPath, parseMetaValue(parsed.value))
            : setAtPath(current, parsed.keyPath, parseMetaValue(parsed.value));
      await patchMeta(client, apiRoot, namespace, route, parsed.id, { [parsed.key]: updated });
      return {
        output: pc.green(`Success: patched meta "${parsed.key}" on ${route} ${parsed.id}.`),
        exitCode: 0,
      };
    }
  }
}
