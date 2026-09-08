# Contributing to wp-rest-cli

Thanks for considering a contribution. This project is a plain Node/TypeScript CLI with no PHP or WordPress
install required to work on it - everything runs against a local fixture HTTP server or, if you want to,
a real WordPress site.

## Getting started

```sh
npm install
```

Run the CLI straight from source with `tsx` - no build step needed while iterating:

```sh
npm run wp -- <namespace> <route> [<verb>] [<id>] [--flag=value...] --url=<site>

# e.g.
npm run wp -- wp/v2 posts list --url=https://example.com --per_page=5
```

If you want a real built binary instead:

```sh
npm run build     # bundles to dist/cli.js via tsup
npm run dev        # tsup --watch
```

## Before submitting a pull request

Run the full local check suite:

```sh
npm test          # vitest: unit tests + the execa-driven integration suite
npm run lint       # eslint .
npm run typecheck  # tsc --noEmit
npm run format     # prettier --write .
```

Run a single test file or a single test by name while iterating:

```sh
npx vitest run test/unit/formatter.test.ts
npx vitest run -t "name substring"
```

## How the test suites work

- **Unit tests** (`test/unit/`) exercise pure logic - command/route parsing, formatting, indexer route
  matching - with no network involved.
- **Integration tests** (`test/integration/cli.test.ts`) are the source of truth for end-to-end CLI
  behavior. They spawn a plain `node:http` fixture server (`test/integration/fixtures/server.ts`) that
  models a `wp/v2` index, a `widgets` collection with full CRUD + `meta`, and a parameterized-only route,
  then drive the actual CLI binary against it via `execa` + `tsx`. **No live WordPress site is needed** to
  run or write these tests, and none should be required to add new ones - when adding a new verb or
  command, prefer extending the fixture and adding an integration test over mocking `fetch` at the unit
  level, since most of the value here is in the URL-building and dispatch logic across the whole pipeline.
  Expect these tests to take seconds rather than milliseconds.

## Architecture

Before making non-trivial changes, please read [`CLAUDE.md`](./CLAUDE.md) in the repo root - it's the
canonical source of truth on how the codebase is organized (command grammar/dispatch, the discovery →
indexer → introspect → verbs → formatter pipeline, `meta` command mapping, help rendering, and testing
conventions), and keeping it up to date is part of any architectural change.

## Branches and pull requests

- Pull requests target `main`.
- Keep PRs focused on a single change; unrelated cleanups are easier to review separately.
- Make sure `npm test`, `npm run lint`, and `npm run typecheck` all pass before requesting review.
- If your change affects behavior or architecture, update `CLAUDE.md` and/or `README.md` alongside the
  code change, not as a follow-up.

## Reporting bugs and requesting features

Please use the issue templates - they ask for the details (command run, expected vs. actual behavior,
CLI/Node/OS versions) that make bugs reproducible.

Security issues should **not** be filed as public issues - see [`SECURITY.md`](./SECURITY.md).
