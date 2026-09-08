# Installation

`wp-rest-cli` isn't published to the npm registry yet (see the note at the bottom of this page), so install it from source.

## Requirements

- Node.js `>= 20`

## Build and run

```sh
git clone https://github.com/spacedmonkey/wp-rest-cli.git
cd wp-rest-cli
npm install
npm run build
```

This bundles the CLI to `dist/cli.js` (via [tsup](https://tsup.egoist.dev/)), which you can run directly:

```sh
./dist/cli.js <namespace> <route> [<verb>] [<id>] [--flag=value...] --url=<site>
```

## Development mode (no build step)

For local development, run commands directly against the TypeScript source via [tsx](https://github.com/privatenumber/tsx):

```sh
npm run wp -- <namespace> <route> [<verb>] [<id>] [--flag=value...] --url=<site>
```

## Development scripts

| Command | Description |
| --- | --- |
| `npm run wp -- <args>` | Run against source via `tsx`, no build needed. |
| `npm run build` | Bundle to `dist/cli.js` (tsup). |
| `npm run dev` | `tsup --watch`. |
| `npm test` | Run the full suite: Jest (unit tests) + Vitest (an execa-driven integration suite against a local fixture server). |
| `npm run test:unit` | Jest only, unit suite only. |
| `npm run test:integration` | Vitest run, integration suite only. |
| `npm run test:watch` | Jest in watch mode (unit suite only; see `test:integration:watch` for the integration suite). |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run lint` | `eslint .`. |
| `npm run format` | `prettier --write .`. |

See [CONTRIBUTING.md](https://github.com/spacedmonkey/wp-rest-cli/blob/main/CONTRIBUTING.md) for the full contributor workflow.

!!! warning "npm package name"
    The package name `wp-rest-cli` (and bin `wp-rest`) is already used by a different, actively-maintained project on the npm registry. This project isn't published under that name yet — it would need to be renamed or scoped (e.g. `@spacedmonkey/wp-rest-cli`) before an `npm publish` could succeed.
