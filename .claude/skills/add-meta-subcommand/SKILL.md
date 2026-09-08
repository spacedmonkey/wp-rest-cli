---
name: add-meta-subcommand
description: Add or change a `wp-rest-cli <namespace> <route> meta <subcommand>` command, or map a new WP-CLI `wp post meta`-style operation onto the REST API's `meta` field. Use when the user wants a new meta subcommand, wants to change how add/update/delete/patch/pluck/list/clean-duplicates/get work, or asks how to expose some WP-CLI meta behavior over REST.
---

# Working on `meta` commands (`src/commands/meta.ts`)

## The fundamental constraint

WP-CLI's `wp post meta` talks to `wp_postmeta` directly via PHP/DB access. This CLI only has HTTP. Over REST, meta **only exists** as the `meta` object field on the parent resource — visible only for keys a plugin/theme registered with `show_in_rest: true`. There is no separate meta collection endpoint, no way to enumerate unregistered meta, and no true "insert a second value under a single-value key" the way direct DB access allows.

Every subcommand in this file is therefore a **documented best-effort mapping** onto "GET the resource, read/mutate `meta`, PATCH it back" — not a literal port of WP-CLI's DB-backed behavior. When adding or changing a subcommand, decide the mapping deliberately and write it into `META_VERB_DESCRIPTIONS` (shown in `wp-rest-cli help <namespace> <route> meta <verb>`) so the gap is visible to users, rather than silently pretending REST parity that doesn't exist. Existing precedent:

- `add` and `update` are identical (no multi-value "add" semantics over REST).
- `clean-duplicates` only does anything for **array-type** meta values (`single: false` registration) — for a scalar value it's a documented no-op.
- `delete <id> <key> <value>` removes **every** array entry that matches `<value>` (mirrors `delete_post_meta($id, $key, $value)`'s "delete all matching rows" semantics, not "delete one occurrence").
- `patch`/`pluck` do **client-side** key-path traversal (`getAtPath`/`setAtPath`/`deleteAtPath`/`insertAtPath`) on the value already fetched via GET — there's no partial-update REST endpoint to delegate to. `patch insert` is defined as "append to the array at that path"; that's a simplification of WP-CLI's PHP implementation, not an exact match — call this out if you change it.

## Where things live

- `MetaVerb` / `META_VERBS` — the fixed list of subcommand names.
- `ParsedMeta` — one union member per subcommand's argument shape. These shapes are genuinely different (compare `list`'s flags-only shape to `patch`'s `<action> <id> <key> <key-path>... [<value>]`), so don't try to unify them into one generic shape.
- `parseMetaArgs(metaVerbToken, tokens)` — parses everything after the literal `meta <verb>` tokens. Positional vs. flag tokens are split purely by whether a token contains `=` (`splitPositionalAndFlags`) — the same convention the rest of the CLI uses for dynamic `--flag=value` args (see `cli.ts`'s `normalizeDynamicFlags`, which rewrites unknown `--flags` into bare `name=value` tokens before this code ever sees them).
- `META_VERB_SYNOPSES` — one-line WP-CLI-style synopsis per subcommand, used both in the combined `usage:`/`or:` block (`printMetaUsage`) and the single-verb help (`printMetaVerbHelp`).
- `runMetaCommand(parsed, client, apiRoot, namespace, route, flags)` — the actual execution, one `case` per `MetaVerb`. `getItem`/`patchMeta` are the only two HTTP calls anything here makes (GET the item with `flags.context`, PUT `{ meta: {...} }`). `getMetaObject` is what throws a clear `CliError` when the route's items don't have a `meta` field at all — call this whenever you fetch an item and need its meta.

## Checklist for a new subcommand

1. Add the name to `MetaVerb` and `META_VERBS`.
2. Add a `ParsedMeta` union member with exactly the positional/flag shape it needs.
3. Add a `case` in `parseMetaArgs` — validate required positionals explicitly (throw `CliError` with the `META_VERB_SYNOPSES[verb](...)`-built usage string, matching the existing pattern) rather than letting `undefined` propagate.
4. Add a description to `META_VERB_DESCRIPTIONS` and a synopsis builder to `META_VERB_SYNOPSES`.
5. Add a `case` in `runMetaCommand`. Decide up front whether it's read-only (`get`/`list`/`pluck`) or needs a GET-then-PATCH round trip (everything that mutates).
6. Add integration tests in `test/integration/cli.test.ts` under the `describe('meta', ...)` block, following the `createWidget()` helper pattern already there — the fixture's `widgets` route already supports `meta` (see `extend-fixture-server` skill if you need a *new* meta-capable route rather than reusing `widgets`).

## Discoverability

The `meta` usage block only appears in `wp-rest-cli <namespace> <route>` / `help <namespace> <route>` output when `routeSupportsMeta(endpoints)` finds a `meta` key in the route's create/update args (from the live OPTIONS schema). If you're testing against a real site and don't see the meta block, that route's post type/object likely hasn't registered any meta with `show_in_rest` — this is expected, not a bug in the detection.
