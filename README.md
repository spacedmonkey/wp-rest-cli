<!-- markdownlint-disable MD033 MD041 -->
<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/logo-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset=".github/assets/logo-light.svg">
    <img src=".github/assets/logo-light.svg" alt="wrapido" width="320">
  </picture>
</p>
<!-- markdownlint-enable MD033 MD041 -->

[![CI](https://github.com/spacedmonkey/wrapido/actions/workflows/ci.yml/badge.svg)](https://github.com/spacedmonkey/wrapido/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)
[![Docs](https://img.shields.io/badge/docs-spacedmonkey.github.io-blue.svg)](https://spacedmonkey.github.io/wrapido/)
![Statements](https://img.shields.io/badge/statements-100%25-brightgreen.svg?style=flat)

<!-- markdownlint-disable-next-line MD033 -->
**<u>W</u>ordPress <u>R</u>EST <u>API</u> <u>Do</u>er**: a fast CLI for any WordPress site.

A WP-CLI-style command line tool for talking to **any** WordPress site's REST API over HTTP — no PHP, no SSH, no WordPress install required locally. It auto-discovers a site's REST API from just a URL, introspects routes the way `?_method=OPTIONS` does, and speaks WP-CLI's own `--format=`/`--fields=` conventions.

> This is an independent project inspired by [wp-cli/restful](https://github.com/wp-cli/restful) and the [2016 "RESTful WP-CLI" update](https://make.wordpress.org/cli/2016/04/14/restful-wp-cli-update-3/), reimplemented as a standalone Node/TypeScript CLI that always talks to a real WordPress REST API over HTTP (rather than running inside WordPress/PHP).

**[Full documentation](https://spacedmonkey.github.io/wrapido/)**

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

```text
wrapido                                                         # discover: list namespaces from the site's REST API index
wrapido <namespace>                                             # list routes registered under that namespace
wrapido <namespace> <route>                                     # introspect: show the route's supported methods/args/context (an OPTIONS request)
wrapido <namespace> <route> list        [--page=] [--per_page=] [...]   # --per_page=-1: every page
wrapido <namespace> <route> get <id>
wrapido <namespace> <route> create      [--field=value...] [--body=<json>]
wrapido <namespace> <route> update <id> [--field=value...] [--body=<json>]
wrapido <namespace> <route> delete <id> [--force]
```

> **TLS:** HTTPS certificates are never verified, so self-signed/expired certs on local or staging sites just work. Avoid real credentials on untrusted networks.

### Global flags

| Flag                                                  | YAML key       | Description                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--url=<site>`                                        | `url`          | WordPress site URL. Required unless a default is saved (`wrapido config set --url=`) or set in a config file.                                                                                                                                                                                                          |
| `--username=<user>`                                   | —              | Also via the `WP_USERNAME` env var. Not allowed in config files.                                                                                                                                                                                                                                                  |
| `--password=<pass>`                                   | —              | Also via the `WP_PASSWORD` env var. A WordPress **Application Password** is strongly recommended over a real account password — see [Authentication](#authentication). Not allowed in config files.                                                                                                               |
| `--client-id=<id>` / `--client-secret=<secret>`       | —              | OAuth2 credential, for `wrapido auth oauth2 login`/`add` — see [OAuth2](docs/authentication-oauth2.md). Not allowed in config files.                                                                                                                                                                                   |
| `--token=<token>`                                     | —              | OAuth2 personal access token, for `wrapido auth oauth2 add`. Not allowed in config files.                                                                                                                                                                                                                              |
| `--use-auth=env\|none\|application-passwords\|oauth2` | `use-auth`     | Pin credential resolution to one source, skipping the rest of the fallback chain — see [Authentication](#authentication).                                                                                                                                                                                         |
| `--context=view\|edit\|embed`                         | `context`      | Default `view`. Run `wrapido <namespace> <route>` to see which values a given route actually supports.                                                                                                                                                                                                                 |
| `--format=table\|json\|csv\|yaml\|ids\|count\|raw`    | `format`       | Default `table`. Table cells are truncated to 50 characters, and nested objects/arrays show as `<object>`/`<array>` unless named via `--fields` (e.g. `--fields=title.rendered`). `count` prints the site total from the `X-WP-Total` response header when WordPress sends one, else the number of rows returned. |
| `--fields=<a,b,c>`                                    | —              | Limit output to specific fields (table/csv also accept dotted paths like `title.rendered`). Per-invocation only. Also sent to the API as `_fields` (except on `delete`) to trim the response, and still filtered locally for endpoints that ignore it.                                                            |
| `--field=<name>`                                      | —              | Print a single field's raw value (supports dotted paths, e.g. `title.rendered`). Per-invocation only.                                                                                                                                                                                                             |
| `--body=<json>`                                       | —              | Raw JSON request body for `create`/`update`, overriding/merged under `--field=` args. Per-invocation only.                                                                                                                                                                                                        |
| `--timeout=<ms>`                                      | `timeout`      | Timeout for every HTTP request; when given it replaces all the defaults below. Defaults: 20000 (20 s) for API calls, 8000 for site discovery and `wrapido auth` calls, and 300000 (5 min) for file uploads/downloads, where it is an idle timeout that resets whenever data moves.                                     |
| `--no-color`                                          | `color: false` | Disable colored output.                                                                                                                                                                                                                                                                                           |
| `--no-truncate`                                       | —              | Show full table cell values instead of truncating them to 50 characters. Per-invocation only.                                                                                                                                                                                                                     |
| `--quiet`                                             | `quiet`        | Suppress spinners.                                                                                                                                                                                                                                                                                                |
| `--debug`                                             | `debug`        | Print a stack trace on unexpected (non-API) errors, and log every HTTP request/response to stderr (with the `Authorization` header redacted) plus the config files loaded.                                                                                                                                        |
| `-h`, `--help`                                        | —              | Show help for the given namespace/route/verb, or the top-level help.                                                                                                                                                                                                                                              |

Flags with a YAML key can be set in a [config file](docs/configuration.md#yaml-config-files); a flag on the command line always wins.

Any other `--name=value` (or bare `--name`, treated as `--name=true`) is passed straight through as a WordPress REST API field or query argument — e.g. `--per_page=5`, `--title="Hello"`, `--force`. Run `wrapido <namespace> <route>` first to see exactly which ones a route accepts.

`list --per_page=-1` fetches **every** page. The REST API itself rejects `-1`, so the CLI works around it the same way Gutenberg's `api-fetch` does: it requests the route's own maximum page size (the `maximum` declared in its schema, usually `100`) and concatenates the pages, in parallel when `X-WP-TotalPages` is sent and otherwise by following `Link: rel="next"`. This only applies to routes that declare both `page` and `per_page`. A progress bar shows while the pages load (hidden by `--quiet`). `--page` is ignored alongside it, with a warning. `--format=count` still makes just one request, and a `per_page` below `-1` is rejected before anything is sent.

## Using with AI agents

Auto-detected inside Claude Code, OpenAI Codex, GitHub Copilot's agent tooling, Cline and Cursor (or set `WRAPIDO_AGENT=1` by hand): JSON by default (compact, `_links`/`_embedded` stripped), no colour or spinners, JSON errors, and warnings for unknown flags. Nothing changes for interactive use. See [docs/agent-mode.md](docs/agent-mode.md) and [AGENTS.md](AGENTS.md) (written for the agent itself).

## Authentication

Use a WordPress core **Application Password** (Users → Profile → Application Passwords, built into WordPress since 5.6), not your real account password:

```sh
wrapido wp/v2 posts list --url=https://example.com --username=admin --password=xxxx xxxx xxxx xxxx xxxx xxxx
```

Application Passwords are revocable and scoped per-application, and work over the same HTTP Basic Auth the CLI always sends — nothing else about how you invoke the CLI changes if you use one. Run `wrapido --url=<site>` to see whether a target site supports them (reported from the REST API index).

You can also store credentials per site with `wrapido auth <type> ...` (`<type>` names the auth mechanism — today just `application-passwords`, matching WordPress's own key for it, leaving room for e.g. `oauth2` later), instead of passing `--username`/`--password` every time — including `wrapido auth application-passwords login <url>`, which obtains an Application Password for you via a browser flow (no copy-pasting a password), the same way `gh auth login`/`claude login` work:

```sh
wrapido auth application-passwords login https://example.com                                      # browser-based Application Password flow
wrapido auth application-passwords add https://example.com --username=admin --password="xxxx xxxx xxxx xxxx xxxx xxxx"  # store one you already have
wrapido auth application-passwords list
```

See [Authentication](https://spacedmonkey.github.io/wrapido/authentication/) for the full `wrapido auth` command reference.

Auth is built behind a small `AuthProvider` interface so other methods (OAuth, cookie/nonce, etc.) can be added later without touching request code.

## Examples

```sh
# Discover a site
wrapido --url=https://example.com

# List routes in a namespace
wrapido wp/v2 --url=https://example.com

# Introspect a route (methods, args, supported --context values)
wrapido wp/v2 posts --url=https://example.com

# List, with query args and JSON output
wrapido wp/v2 posts list --per_page=5 --format=json --url=https://example.com

# Get one, as edit context, authenticated
wrapido wp/v2 posts get 42 --context=edit --url=https://example.com --username=admin --password=xxxx-xxxx-xxxx-xxxx

# Create
wrapido wp/v2 posts create --title="Hello" --status=publish --url=https://example.com

# Update
wrapido wp/v2 posts update 42 --status=draft --url=https://example.com

# Delete
wrapido wp/v2 posts delete 42 --force --url=https://example.com

# Upload a file — the flag is whatever parameter the endpoint expects (`file` for core media)
wrapido wp/v2 media create --file=./cat.jpg --title="Cat" --url=https://example.com

# Save defaults so you don't have to repeat --url/--username
wrapido config set --url=https://example.com --username=admin
wrapido config get
wrapido config clear

# Store per-site credentials instead of passing --username/--password every time
wrapido auth application-passwords login https://example.com
wrapido auth application-passwords list
wrapido auth application-passwords remove --all   # if a machine/config is ever compromised
wrapido config rotate-key   # re-encrypt the local store under a fresh key
```

See [Uploading files](https://spacedmonkey.github.io/wrapido/uploading-files/) for batches, URL imports and other endpoints.

## Development

```sh
npm run wp -- <args>   # run against source via tsx, no build needed
npm run build          # bundle to dist/cli.js (tsup)
npm test                # jest (unit, via wp-scripts) + vitest (an execa-driven integration suite against a local fixture server)
npm run coverage        # merged unit + integration coverage report (coverage/) and README badge update
npm run typecheck
npm run lint            # wp-scripts lint-js — WordPress/Gutenberg coding standards
npm run format          # wp-scripts format
```

Code style follows the [WordPress/Gutenberg JavaScript coding standards](https://developer.wordpress.org/coding-standards/wordpress-coding-standards/javascript/), via `@wordpress/scripts`, `@wordpress/eslint-plugin`, and `@wordpress/prettier-config`.

## Design notes

-   **Discovery**: `HEAD` the site → read the `Link: <...>; rel="https://api.w.org/"` header → fall back to the HTML `<link>` tag → fall back to probing `/wp-json/` then `/?rest_route=/`.
-   **Verbs, not raw HTTP methods**: `list`/`get`/`create`/`update`/`delete` mirror WP-CLI's own `wp post list`/`wp post create`/etc., but layered onto generic `<namespace> <route>` addressing so they work against any namespace — core or plugin — not just hardcoded resource names.
-   **Credentials**: `--username`/`--password` (or `WP_USERNAME`/`WP_PASSWORD`) always take precedence; `wrapido auth <type> login`/`add` can additionally store a credential per site as a fallback for requests that omit them, encrypted at rest under a random key generated once per machine and kept in its own file — protects a leaked/copied config file alone, not against something with full account-level read access (an OS keychain would be needed for that, deliberately out of scope to avoid a native-binding dependency). `<type>` names the auth mechanism — `application-passwords` today, matching the key WordPress's own REST API index uses for it, with the grammar (and an exhaustively-checked `AuthType` union internally) already shaped for a second type — e.g. `oauth2` — to be added later without changing the command shape again. `wrapido config rotate-key` regenerates the encryption key, and `wrapido auth application-passwords remove --all` revokes-where-possible and forgets every stored credential, as an incident-response pair if a machine or its config is ever suspected compromised. `add` verifies a credential against the site before saving (unless `--skip-verify`); `login`/`remove` revoke the Application Password on the site itself, not just locally, whenever the credential being replaced/removed was confirmed to be one.
-   **Packages**: `commander` (parsing), native `fetch` (HTTP), `ora` (spinner), `table` + `flat` (table rendering with dot-flattened nested fields), `json-2-csv` (CSV), `yaml` (YAML), `picocolors` (colors), `conf` + `env-paths` (saved defaults + per-site credentials, and locating the per-machine encryption key file), `@wordpress/url` (query-string building).

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for how to get set up, the test/lint/typecheck expectations, and how to propose a change.

## License

MIT — see [LICENSE](LICENSE) for the full text.
