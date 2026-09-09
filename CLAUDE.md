# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`wp-rest-cli` is a WP-CLI-style command line tool that talks to **any** WordPress site's REST API over plain HTTP — no PHP, no SSH, no local WordPress install. It auto-discovers a site's REST API from just a URL, introspects routes the way `?_method=OPTIONS` does, and speaks WP-CLI's own `--format=`/`--fields=` conventions. It's an independent reimplementation inspired by `wp-cli/restful`, not a WP-CLI plugin — everything happens over HTTP against a real site.

## Commands

```sh
npm run wp -- <namespace> <route> [<verb>] [<id>] [--flag=value...] --url=<site>  # run against src/ via tsx, no build needed
npm run build          # bundle to dist/cli.js (tsup)
npm run dev             # tsup --watch
npm test                 # jest (unit, via wp-scripts) + vitest run (an execa-driven integration suite against a local fixture server)
npm run test:unit        # wp-scripts test-unit-js (jest), unit suite only
npm run test:integration # vitest run, integration suite only
npm run test:watch       # wp-scripts test-unit-js --watch (unit only; see test:integration:watch for the integration suite)
npm run typecheck       # tsc --noEmit
npm run lint            # wp-scripts lint-js (WordPress/Gutenberg coding standards, via @wordpress/eslint-plugin)
npm run lint:pkg-json   # wp-scripts lint-pkg-json (validates package.json, via npm-package-json-lint)
npm run format          # wp-scripts format (WordPress/Gutenberg coding standards, via @wordpress/prettier-config)
```

Run a single unit test file: `NODE_OPTIONS=--experimental-vm-modules npx wp-scripts test-unit-js formatter.test.ts`. Run a single unit test by name: `NODE_OPTIONS=--experimental-vm-modules npx wp-scripts test-unit-js -t "name substring"`. The integration suite (`test/integration/cli.test.ts`) spawns the CLI via `execa`/`tsx` against an in-process HTTP fixture server (`test/integration/fixtures/server.ts`), so it's slower (seconds, not ms) than the unit tests — expect that when iterating. Run just that suite with `npx vitest run test/integration/cli.test.ts` or `npx vitest run -t "name substring"`.

### Coding standards

This project follows WordPress/Gutenberg JavaScript coding standards, enforced via `@wordpress/scripts`:

- `eslint.config.js` spreads `@wordpress/eslint-plugin`'s flat `recommended` config (which itself pulls in `@wordpress/prettier-config`-aware formatting rules and TypeScript support via `typescript-eslint`, since both `prettier` and `typescript` are installed). Project-specific overrides on top: a `_`-prefixed-arg allowance for `@typescript-eslint/no-unused-vars`, and `no-console: off` for `src/cli.ts`/`src/core/debug.ts` (a CLI's whole job is printing).
- `.prettierrc.cjs` re-exports `@wordpress/prettier-config` as-is (tabs, single quotes, `printWidth: 80`). `prettier` itself is aliased to `npm:wp-prettier` (WordPress's own Prettier fork) in `devDependencies`, since `wp-scripts format`/`lint-js` require that exact package to be installed under the `prettier` name — a plain `prettier` install will not satisfy them.
- `.npmpackagejsonlintrc.json` extends `@wordpress/npm-package-json-lint-config` (used by `npm run lint:pkg-json`) but overrides `valid-values-license` to allow `MIT` — the WordPress default expects `GPL-2.0-or-later`, which fits a WP plugin but not this project (an independent, MIT-licensed CLI tool, not a WP-CLI plugin — see "What this is" above).
- `.prettierignore` excludes `.github/`, `*.yml`/`*.yaml`, and `mkdocs.yml` — the WordPress formatting/tab-indent rules apply to this project's JS/TS/JSON, not to CI workflow or docs-site YAML.
- JSDoc is required on functions (`jsdoc/require-param` etc., from the WordPress config) — see the existing `src/` files for the expected style (a one-line summary, `@param`/`@return` with real descriptions, not bare tags).

## Architecture

### Command grammar and dispatch

The whole CLI is one dynamic grammar, not a fixed command tree:

```text
wp                                                              # list namespaces
wp <namespace>                                                  # list routes under that namespace
wp <namespace> <route>                                          # introspect: methods/args/context via OPTIONS
wp <namespace> <route> list|get|create|update|delete|exists|generate [...]
wp <namespace> <route> meta <add|clean-duplicates|delete|get|list|patch|pluck|update> ...
wp help [<namespace> [<route...> [<verb>]]]                     # same shapes, but never performs the request
wp config get|set|clear
```

- `src/cli.ts` is the Commander entry point. It only owns a fixed set of long flags (`KNOWN_LONG_FLAGS`); any other `--name=value` or bare `--flag` is rewritten by `normalizeDynamicFlags` into a positional `name=value` token before Commander sees it, because those are dynamic WordPress field/query args whose names aren't known ahead of time (e.g. `--per_page=5`, `--title=`, `--force`). `config` and `help` are intercepted as special first-argument subcommands before the rest of the positional args reach the main dispatch.
- `src/commands/rest.ts` is the core dispatcher: `parseCommandArgs`/`parseHelpArgs` turn the raw positional args into a `ParsedCommand`/`ParsedHelp`, and `runRestCommand`/`runHelpCommand` execute them.
- **Route parsing is intentionally loose**: `consumeRouteSegments` greedily consumes leading tokens as `/`-joined route segments until it hits a recognized verb, the literal `meta` keyword, or a `field=value`-shaped token. This lets a WordPress route that's nested under several literal path segments (e.g. `WP_REST_Global_Styles_Controller`'s `global-styles/themes/(?P<stylesheet>%s)`) be addressed as separate CLI words (`wp wp/v2 global-styles themes get <stylesheet>`), the same way WP-CLI addresses nested commands. A consequence: a genuinely unrecognized verb-position token is no longer rejected locally — it's folded into the route and left to fail naturally as a live 404 from the API, rather than a local "unknown verb" error.
- **Routes are discoverable level-by-level, not just addressable once known**: `core/indexer.ts`'s `routeChildren` groups a namespace's routes by their next `/`-segment beneath whatever prefix has been typed so far, to arbitrary depth. `wp <namespace>` (empty prefix) and bare `wp <namespace> <route>` introspection both consult it before falling through to `resolveRouteInfo`/schema introspection — if the typed prefix has further segments underneath it, the child segments are listed instead (a pure-container child that isn't itself a route is marked `(subcommand)`). This means a route like `global-styles/themes` doesn't have to be typed in full to be found: `wp wp/v2` → `wp wp/v2 global-styles` → `wp wp/v2 global-styles themes` each reveal the next step, the same way WP-CLI's own nested commands (`wp post meta ...`) are explored one word at a time. `wp help <namespace> [<route...>]` mirrors this exactly. A namespace where every route is a single segment (the common case) is unaffected — `routeChildren` at the root just lists each route once, same as before. A route can be a **"hybrid"** — both directly addressable *and* a container for further children (e.g. once a `variations` child is registered beneath the already-addressable `global-styles/themes`) — `runRestCommand`/`runHelpCommand` check `isRealRoute` before deciding whether bare introspection should show the route's own schema or just its children; a hybrid gets its own schema plus a `renderChildrenNote` listing appended.
- **A route's URL parameter isn't always at the end**: `core/indexer.ts`'s `splitPlaceholder` finds a single `(?P<name>...)` placeholder *anywhere* in a route's path (not just trailing) and reports both the route's literal segments with it removed and the position it belongs at (`paramIndex`). This is how e.g. real WordPress's `/wp/v2/posts/(?P<parent>[\d]+)/revisions` (parameter in the middle) becomes CLI-addressable as `wp wp/v2 posts revisions get <parent>` — `routesForNamespace`/`resolveRouteInfo` use the joined literal segments (`posts/revisions`) as the route name, `supportedVerbsForRoute` adds `get`/`exists` to it (in addition to whatever collection verb it already has) since it needs a value to be addressed at all, and `core/verbs.ts`'s `buildVerbRequest` splices the id back into `route.split('/')` at `paramIndex` (defaulting to the end, matching every route this CLI supported before mid-path parameters existed) rather than always appending it. A path with more than one placeholder (e.g. one specific revision, needing both a parent post id and a revision id) isn't addressable by this CLI's single-`<id>` grammar and stays invisible, same as before.
- `verb`/`get`/`update`/`delete`/`exists` require an `<id>` as the first token after the verb; `list`/`create`/`generate` don't, and treat everything after the verb as `field=value` pairs.

### Layering under the dispatcher

- `core/discovery.ts` — resolves a bare site URL to its REST API root: `HEAD` for the `Link: <...>; rel="https://api.w.org/"` header → GET + HTML `<link>` tag fallback → probe `/wp-json/` → probe `/?rest_route=/`.
- `core/indexer.ts` — fetches the site's root index (`fetchIndex`) and derives the route list for a namespace (`routesForNamespace`). Routes registered only in parameterized form with no bare collection sibling (like the global-styles/themes example above) are still listed, by their base path with the trailing `(?P<...>)` segment stripped — `resolveRouteInfo` is what later tells the rest of the code that such a route needs a real OPTIONS request against an *instantiated* URL (or a fallback to the index's own embedded schema) rather than the bare collection path, which would 404.
- `core/introspect.ts` — `introspectRoute` does the live OPTIONS request; `supportedContexts` reads the `context` enum out of the resulting schema.
- `core/verbs.ts` — `buildVerbRequest` maps a `SingleRequestVerb` (`list`/`get`/`create`/`update`/`delete`/`exists` — i.e. every verb *except* `generate`, which isn't a single HTTP request) plus id/fields/content into a `{method, url, body}`. `generate` is handled entirely in `rest.ts` as a loop of `create` calls; `exists` reuses `get`'s request shape but is interpreted specially by the caller (404 → exit 1, not an error).
- `core/validate.ts` — `validateFieldTypes`, called from `rest.ts`'s `validateVerbFields` before a `list`/`create`/`update`/`generate` request is sent, catches two kinds of problem locally against the route's live arg schema: a `field=value` whose value doesn't match its declared JSON Schema type (e.g. `--per_page=abc` for an `integer` arg), and — only when its `checkRequired` param is set — a `required` arg missing from `fields` altogether. `validateVerbFields` only passes `checkRequired: true` for `create`/`generate`: `update` reuses the same (POST) schema (see `COLLECTION_VERB_METHOD` below) but a partial update legitimately omits create-time required fields, so it must not be held to them.
- `core/formatter.ts` — `formatOutput` renders a response body per `--format` (`table`/`json`/`csv`/`yaml`/`ids`/`count`/`raw`), including `--fields`/`--field` selection and dot-flattening nested objects for table/csv. Table cells are sanitized of control characters the `table` package rejects (real post content routinely contains raw `\t`/`\r`).
- `core/client.ts` — thin `fetch` wrapper (`WpRestClient`) that attaches auth headers and turns non-2xx responses into a `WpApiError`.
- `core/errors.ts` — `WpApiError` (parsed `{code,message,data}` from the REST API) vs `CliError` (the CLI's own local validation failures); `formatErrorForDisplay` is what the top-level catch in `cli.ts` prints.
- `core/auth/` — `AuthProvider` interface with a `BasicAuthProvider` implementation (username/password or WordPress Application Password over HTTP Basic Auth). Built as an interface so other auth methods can be added without touching request code.
- `src/config.ts` — persists `--url`/`--username` defaults on disk via `conf` (`wp config get|set|clear`). Passwords are never persisted, only ever taken from `--password`/`WP_PASSWORD`.

### `meta` commands (`src/commands/meta.ts`)

WP-CLI's `wp post meta` talks to `wp_postmeta` directly. Over REST there's no such table access — meta only exists as the `meta` object field on the parent resource (visible only for keys registered with `show_in_rest`), read via `GET` and written by `PATCH`ing `{meta: {...}}` onto the resource. Every one of the 8 subcommands (`add`/`clean-duplicates`/`delete`/`get`/`list`/`patch`/`pluck`/`update`) is a best-effort mapping onto that model rather than a literal port — notably `add` behaves identically to `update` (REST has no multi-value "add"), and `clean-duplicates` only does anything for array-type (`single: false`) fields. `patch`/`pluck` do client-side key-path traversal on the fetched value (see `getAtPath`/`setAtPath`/`deleteAtPath`) since REST has no partial-update endpoint for nested structures. The `meta` usage synopsis is only shown for a route whose create/update schema actually declares a `meta` arg (`routeSupportsMeta`).

### Help output

`renderRouteHelp`/`printVerbHelp` in `rest.ts` render a WP-CLI-style `usage: ... \n   or: ...` synopsis block per route/verb, built dynamically from the *live* introspected schema (not a hardcoded field list the way WP-CLI's own `wp post create` synopsis is) — so the exact flags shown differ per site and per route. `update`/`generate`'s argument list is borrowed from the `create` (POST) schema as the closest available approximation, since the item-level PUT endpoint's schema isn't exposed by the collection's OPTIONS response.

### Testing conventions

- Unit tests (`test/unit/`), run under **Jest** (ESM via `ts-jest`, config in `jest.config.js`), test pure logic (parsing, formatting, indexer route-matching) with no network. Jest's ESM setup here can't hoist `jest.mock()` module replacement the way Vitest's `vi.mock()` did — a future test needing to mock one of this project's own modules would need `jest.unstable_mockModule()` plus a dynamic `import()`.
- The integration suite (`test/integration/cli.test.ts`), run under **Vitest** (`vitest.config.ts` now scopes it to `test/integration/**`), is the source of truth for end-to-end CLI behavior: it starts `test/integration/fixtures/server.ts` (a plain `node:http` server modeling a `wp/v2` index, a `widgets` collection with full CRUD + `meta`, and a parameterized-only `global-styles/themes` route) and drives the actual CLI binary via `execa` + `tsx`. When adding a new verb/command, prefer extending this fixture and adding an integration test over mocking `fetch` at the unit level, since most of the value here is in the URL-building and dispatch logic across the whole pipeline.
