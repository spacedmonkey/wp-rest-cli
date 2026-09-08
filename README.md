# wp-rest-cli

[![CI](https://github.com/spacedmonkey/wp-rest-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/spacedmonkey/wp-rest-cli/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)
[![Docs](https://img.shields.io/badge/docs-spacedmonkey.github.io-blue.svg)](https://spacedmonkey.github.io/wp-rest-cli/)

A WP-CLI-style command line tool for talking to **any** WordPress site's REST API over HTTP — no PHP, no SSH, no WordPress install required locally. It auto-discovers a site's REST API from just a URL, introspects routes the way `?_method=OPTIONS` does, and speaks WP-CLI's own `--format=`/`--fields=` conventions.

> This is an independent project inspired by [wp-cli/restful](https://github.com/wp-cli/restful) and the [2016 "RESTful WP-CLI" update](https://make.wordpress.org/cli/2016/04/14/restful-wp-cli-update-3/), reimplemented as a standalone Node/TypeScript CLI that always talks to a real WordPress REST API over HTTP (rather than running inside WordPress/PHP).

**[Full documentation](https://spacedmonkey.github.io/wp-rest-cli/)**

## Install

```sh
npm install
npm run build
```

For local development, run commands directly against the TypeScript source without a build step:

```sh
npm run wp -- <namespace> <route> [<verb>] [<id>] [--flag=value...] --url=<site>
```

## Command grammar

```
wp                                                              # discover: list namespaces from the site's REST API index
wp <namespace>                                                  # list routes registered under that namespace
wp <namespace> <route>                                          # introspect: show the route's supported methods/args/context (an OPTIONS request)
wp <namespace> <route> list        [--page=] [--per_page=] [...]
wp <namespace> <route> get <id>
wp <namespace> <route> create      [--field=value...] [--content=<json>]
wp <namespace> <route> update <id> [--field=value...] [--content=<json>]
wp <namespace> <route> delete <id> [--force]
```

### Global flags

| Flag | Description |
| --- | --- |
| `--url=<site>` | WordPress site URL. Required unless a default is saved (`wp config set --url=`). |
| `--username=<user>` | Also via the `WP_USERNAME` env var. |
| `--password=<pass>` | Also via the `WP_PASSWORD` env var. A WordPress **Application Password** is strongly recommended over a real account password — see below. |
| `--context=view\|edit\|embed` | Default `view`. Run `wp <namespace> <route>` to see which values a given route actually supports. |
| `--format=table\|json\|csv\|yaml\|ids\|count\|raw` | Default `table`. |
| `--fields=<a,b,c>` | Limit output to specific top-level fields. |
| `--field=<name>` | Print a single field's raw value (supports dotted paths, e.g. `title.rendered`). |
| `--content=<json>` | Raw JSON request body for `create`/`update`, overriding/merged under `--field=` args. |
| `--no-color` | Disable colored output. |
| `--quiet` | Suppress spinners. |
| `--debug` | Print a stack trace on unexpected (non-API) errors. |

Any other `--name=value` (or bare `--name`, treated as `--name=true`) is passed straight through as a WordPress REST API field or query argument — e.g. `--per_page=5`, `--title="Hello"`, `--force`. Run `wp <namespace> <route>` first to see exactly which ones a route accepts.

## Authentication

Use a WordPress core **Application Password** (Users → Profile → Application Passwords, built into WordPress since 5.6), not your real account password:

```sh
wp-rest-cli wp/v2 posts list --url=https://example.com --username=admin --password=xxxx xxxx xxxx xxxx xxxx xxxx
```

Application Passwords are revocable and scoped per-application, and work over the same HTTP Basic Auth the CLI always sends — nothing else about how you invoke the CLI changes if you use one. Run `wp-rest-cli --url=<site>` to see whether a target site supports them (reported from the REST API index).

Auth is built behind a small `AuthProvider` interface so other methods (OAuth, cookie/nonce, etc.) can be added later without touching request code.

## Examples

```sh
# Discover a site
wp-rest-cli --url=https://example.com

# List routes in a namespace
wp-rest-cli wp/v2 --url=https://example.com

# Introspect a route (methods, args, supported --context values)
wp-rest-cli wp/v2 posts --url=https://example.com

# List, with query args and JSON output
wp-rest-cli wp/v2 posts list --per_page=5 --format=json --url=https://example.com

# Get one, as edit context, authenticated
wp-rest-cli wp/v2 posts get 42 --context=edit --url=https://example.com --username=admin --password=xxxx-xxxx-xxxx-xxxx

# Create
wp-rest-cli wp/v2 posts create --title="Hello" --status=publish --url=https://example.com

# Update
wp-rest-cli wp/v2 posts update 42 --status=draft --url=https://example.com

# Delete
wp-rest-cli wp/v2 posts delete 42 --force --url=https://example.com

# Save defaults so you don't have to repeat --url/--username
wp-rest-cli config set --url=https://example.com --username=admin
wp-rest-cli config get
wp-rest-cli config clear
```

## Development

```sh
npm run wp -- <args>   # run against source via tsx, no build needed
npm run build          # bundle to dist/cli.js (tsup)
npm test                # jest (unit, via wp-scripts) + vitest (an execa-driven integration suite against a local fixture server)
npm run typecheck
npm run lint            # wp-scripts lint-js — WordPress/Gutenberg coding standards
npm run format          # wp-scripts format
```

Code style follows the [WordPress/Gutenberg JavaScript coding standards](https://developer.wordpress.org/coding-standards/wordpress-coding-standards/javascript/), via `@wordpress/scripts`, `@wordpress/eslint-plugin`, and `@wordpress/prettier-config`.

## Design notes

- **Discovery**: `HEAD` the site → read the `Link: <...>; rel="https://api.w.org/"` header → fall back to the HTML `<link>` tag → fall back to probing `/wp-json/` then `/?rest_route=/`.
- **Verbs, not raw HTTP methods**: `list`/`get`/`create`/`update`/`delete` mirror WP-CLI's own `wp post list`/`wp post create`/etc., but layered onto generic `<namespace> <route>` addressing so they work against any namespace — core or plugin — not just hardcoded resource names.
- **Credentials**: v1 is flags/env vars only (`--username`/`--password`, `WP_USERNAME`/`WP_PASSWORD`). Optional OS-keychain "remember me" storage is a natural future addition (e.g. via `@napi-rs/keyring`, the maintained `keytar` replacement) but isn't built yet, to keep the CLI free of native-binding install requirements.
- **Packages**: `commander` (parsing), native `fetch` (HTTP), `ora` (spinner), `table` + `flat` (table rendering with dot-flattened nested fields), `json-2-csv` (CSV), `yaml` (YAML), `picocolors` (colors), `conf` (saved defaults), `@wordpress/url` (query-string building).

## Known limitation

The package name `wp-rest-cli` (and bin `wp-rest`) is already used by a different, actively-maintained project on npm. This repo is not published under that name yet — rename or scope it (e.g. `@you/wp-rest-cli`) before running `npm publish`.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for how to get set up, the test/lint/typecheck expectations, and how to propose a change.

## License

MIT — see [LICENSE](LICENSE) for the full text.
