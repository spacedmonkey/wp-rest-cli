---
tags:
  - cli
  - installation
---

# Installation

`wrapido` isn't published to the npm registry yet (see the note at the bottom of this page), so install it from source.

## Requirements

- Node.js `>= 20`

## Build and run

```sh
git clone https://github.com/spacedmonkey/wrapido.git
cd wrapido
npm install
npm run build
```

This bundles the CLI to `dist/cli.js` (via [tsup](https://tsup.egoist.dev/)), which you can run directly:

```sh
./dist/cli.js <namespace> <route> [<verb>] [<id>] [--flag=value...] --url=<site>
```

## Install globally

To use the `wrapido` command from anywhere, instead of running it from inside the cloned repo:

```sh
git clone https://github.com/spacedmonkey/wrapido.git
cd wrapido
npm install
npm run build
npm install -g .
```

`npm install -g .` uses the `bin` entry in `package.json` to link a `wrapido` command onto your `PATH`, pointing at the `dist/cli.js` you just built. Confirm it worked with:

```sh
wrapido --help
```

To pick up later updates, `git pull` and re-run `npm run build && npm install -g .`.

If you're actively developing `wrapido` itself, `npm link` is more convenient than reinstalling on every change — it symlinks the global `wrapido` command to this working copy, so a rebuild (`npm run build`, or leave `npm run dev` running) is picked up immediately:

```sh
npm link
```

Remove either kind of global install with:

```sh
npm uninstall -g wrapido
```

## Development mode (no build step)

For local development, run commands directly against the TypeScript source via [tsx](https://github.com/privatenumber/tsx):

```sh
npm run wrapido -- <namespace> <route> [<verb>] [<id>] [--flag=value...] --url=<site>
```

## Development scripts

| Command | Description |
| --- | --- |
| `npm run wrapido -- <args>` | Run against source via `tsx`, no build needed. |
| `npm run build` | Bundle to `dist/cli.js` (tsup). |
| `npm run dev` | `tsup --watch`. |
| `npm test` | Run the full suite: Jest (unit tests) + Vitest (an execa-driven integration suite against a local fixture server). |
| `npm run test:unit` | Jest only, unit suite only. |
| `npm run test:integration` | Vitest run, integration suite only. |
| `npm run test:watch` | Jest in watch mode (unit suite only; see `test:integration:watch` for the integration suite). |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run lint` | `eslint .`. |
| `npm run format` | `prettier --write .`. |

See [CONTRIBUTING.md](https://github.com/spacedmonkey/wrapido/blob/main/CONTRIBUTING.md) for the full contributor workflow.

## Note on npm registry publishing

`wrapido` isn't published to the npm registry yet. Once it is, global installation will collapse to a single command:

```sh
npm install -g wrapido
```

Until then, use the from-source steps under [Install globally](#install-globally) above.
