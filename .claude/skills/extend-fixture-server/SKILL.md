---
name: extend-fixture-server
description: Add or modify the local HTTP fixture server used by wp-rest-cli's integration tests, or write a new integration test against it. Use when the user wants to test a new route/verb/feature end-to-end, add a WordPress REST behavior to the test fixture (e.g. a new endpoint, error shape, or resource), or asks why an integration test can't reach some endpoint.
---

# Working with `test/integration/fixtures/server.ts`

## Why this exists

The integration suite (`test/integration/cli.test.ts`) doesn't hit a real WordPress site — it spins up a plain `node:http` server that plays the part of one, then drives the **actual built CLI** against it via `execa('tsx', [cliEntry, ...args, ...])`. This is the source of truth for "does the whole pipeline actually work" (URL building, discovery, OPTIONS introspection, dispatch, formatting) — prefer extending this over mocking `fetch` in a unit test, since most bugs in this codebase are about how the pieces connect, not about any single function's logic in isolation.

The fixture currently models:
- `/wp-json/` — the root index, listing `namespaces: ['wp/v2']` and a `routes` map. Note real WordPress's actual root index is much larger (it embeds full per-route schemas); this fixture keeps `routes` entries minimal (`methods` + a bare `endpoints` skeleton) and relies on a separate OPTIONS handler for full schema — mirroring how `core/indexer.ts`'s `getRouteSchema` normally prefers a live OPTIONS request over the index's own (thinner, in this fixture) schema, falling back to the index only for the parameterized-only-route case.
- `/wp-json/wp/v2/widgets` — a full CRUD collection (GET/POST) + item (GET/PUT/DELETE) resource, with a `meta` field (object, with `color`/`tags` as example registered keys) so it doubles as the fixture for `meta` subcommand tests.
- `/wp-json/wp/v2/global-styles/themes/(?P<stylesheet>%s)` — modeled on `WP_REST_Global_Styles_Controller`: registered **only** in parameterized form, no bare collection at all, GET-only. This is what exercises `resolveRouteInfo`'s "requires a URL parameter" path and the multi-segment route parsing (`wp/v2 global-styles themes get <stylesheet>`).

## Adding a new fixture resource or behavior

1. Add the route's entry to the `routes` map in the `/wp-json/` handler (namespace, `methods`, and a plausible `endpoints` skeleton — this is what shows up in `wp-rest-cli <namespace>`'s route listing).
2. If the route needs full schema (arg names, types, `required`, `enum`, `default`, `description`) for introspection/help tests, add an `OPTIONS` handler for its collection URL returning that shape — copy the `widgets` OPTIONS handler's structure. This is what powers the `usage:`/`or:` synopsis and the detailed arg listing in `wp-rest-cli <namespace> <route>`.
3. Add GET/POST/PUT/DELETE handlers as needed, matching real WordPress response shapes closely enough for the CLI's formatting/field-extraction code to exercise realistically (e.g. `title: { rendered: ... }`, numeric `id`, error bodies shaped like `{ code, message, data: { status } }` — see `parseErrorResponse` in `core/errors.ts` for the exact shape it expects).
4. If mutating state (a `Map` like `widgets`), remember state persists **across tests in the same file** (the fixture is started once in `beforeAll`). Don't assume a fresh resource id in every test — either create your own resource inside the test (see the `createWidget()` helper in the `meta`/`generate`/`exists` `describe` blocks) or be explicit about which earlier test's side effects you're relying on (see the comment above the "delete-verb help" test about widget 2).
5. Match the `send(res, status, body)` / `readBody(req)` helpers already at the top of the file rather than reaching for `express` or another framework — this is deliberately a zero-dependency raw `http` server.

## Writing the test

- Use the `run(args)` helper at the top of `cli.test.ts` — it appends `--url=<fixture.baseUrl> --quiet --no-color` and sets `reject: false`, so check `result.exitCode`/`result.stdout`/`result.stderr` explicitly rather than relying on `execa` throwing.
- Integration tests are slow (roughly 0.8–4s each, since each is a real subprocess + tsx startup); group related assertions into one test rather than one `it()` per assertion where reasonable, but keep independent behaviors (success path vs. error path vs. `--format` variants) as separate `it()`s for clear failure attribution.
- Run just this file while iterating: `npx vitest run test/integration/cli.test.ts`. Run one test by name: `npx vitest run test/integration/cli.test.ts -t "name substring"`.
