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
npm test          # jest (unit tests, via wp-scripts) + vitest (the execa-driven integration suite)
npm run lint       # wp-scripts lint-js (WordPress/Gutenberg coding standards)
npm run typecheck  # tsc --noEmit
npm run format     # wp-scripts format
```

Run a single test file or a single test by name while iterating:

```sh
NODE_OPTIONS=--experimental-vm-modules npx wp-scripts test-unit-js formatter.test.ts     # unit
NODE_OPTIONS=--experimental-vm-modules npx wp-scripts test-unit-js -t "name substring"   # unit

npx vitest run test/integration/cli.test.ts                           # integration
npx vitest run -t "name substring"                                    # integration
```

## Coding standards

This project follows WordPress/Gutenberg JavaScript coding standards. `eslint.config.js` and
`.prettierrc.cjs` are built on `@wordpress/eslint-plugin` and `@wordpress/prettier-config`
respectively (via `@wordpress/scripts`), so `npm run lint`/`npm run format` enforce the same rules
as Gutenberg itself — including required JSDoc on functions. Don't hand-roll ESLint/Prettier config
changes that diverge from those packages' defaults; add a narrowly-scoped override in
`eslint.config.js` instead, with a comment explaining why (see the existing `no-console` override
for `src/cli.ts`/`src/core/debug.ts` as an example).

## How the test suites work

- **Unit tests** (`test/unit/`), run under **Jest**, exercise pure logic - command/route parsing,
  formatting, indexer route matching - with no network involved.
- **Integration tests** (`test/integration/cli.test.ts`), run under **Vitest**, are the source of truth
  for end-to-end CLI behavior. They spawn a plain `node:http` fixture server
  (`test/integration/fixtures/server.ts`) that models a `wp/v2` index, a `widgets` collection with full
  CRUD + `meta`, and a parameterized-only route, then drive the actual CLI binary against it via `execa` +
  `tsx`. **No live WordPress site is needed** to run or write these tests, and none should be required to
  add new ones - when adding a new verb or command, prefer extending the fixture and adding an
  integration test over mocking `fetch` at the unit level, since most of the value here is in the
  URL-building and dispatch logic across the whole pipeline, and Jest's ESM setup here can't hoist
  `jest.mock()` module replacement the way Vitest's `vi.mock()` did. Expect these tests to take seconds
  rather than milliseconds.

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
