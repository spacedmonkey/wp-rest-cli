# Usage

## Command grammar

The whole CLI is one dynamic grammar built from whatever routes a site's REST API actually registers — there's no fixed command tree to memorize:

```text
wrapido                                                         # discover: list namespaces from the site's REST API index
wrapido <namespace>                                             # list routes registered under that namespace
wrapido <namespace> <route>                                     # introspect: show the route's supported methods/args/context (an OPTIONS request)
wrapido <namespace> <route> list        [--page=] [--per_page=] [...]   # --per_page=-1: every page
wrapido <namespace> <route> get <id>
wrapido <namespace> <route> create      [--field=value...] [--body=<json>]
wrapido <namespace> <route> update <id> [--field=value...] [--body=<json>]
wrapido <namespace> <route> delete <id> [--force]
wrapido <namespace> <route> exists <id>
wrapido <namespace> <route> generate    [--count=<n>] [--field=value...]
wrapido <namespace> <route> meta <add|clean-duplicates|delete|get|list|patch|pluck|update> ...
wrapido help [<namespace> [<route...> [<verb>]]]                # same shapes, but never performs the request
wrapido config get|set|clear
```

-   `list`/`create`/`generate` don't take an `<id>` — everything after the verb is treated as `field=value` pairs.
-   `get`/`update`/`delete`/`exists` require an `<id>` as the first token after the verb.
-   `exists` reuses `get`'s request shape but reports success/failure instead of printing the resource: exit code `0` if the id exists, `1` if it doesn't (a `404`).
-   Any failure — a bad flag, a live API error, a network problem — prints `Error: ...` (or, under `--format=json`/[agent mode](agent-mode.md), a JSON `{"error":{...}}` object) to **stderr** and exits `1`; stdout is left untouched. Success exits `0`.
-   `generate` isn't a single HTTP request — it loops `create` `--count` times, reusing the same fields for each item.
-   A route registered under nested literal path segments (e.g. a theme's `global-styles/themes/(?P<stylesheet>%s)`) is addressed as separate words, the same way WP-CLI addresses nested commands — e.g. `wrapido wp/v2 global-styles themes get <stylesheet>`.

## Global flags

| Flag                                                  | YAML key       | Description                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--url=<site>`                                        | `url`          | WordPress site URL. Required unless a default is saved (`wrapido config set --url=`) or set in a config file.                                                                                                                                                                                                                                                                                           |
| `--username=<user>`                                   | —              | Also via the `WP_USERNAME` env var. Not allowed in config files.                                                                                                                                                                                                                                                                                                                                   |
| `--password=<pass>`                                   | —              | Also via the `WP_PASSWORD` env var. A WordPress **Application Password** is strongly recommended over a real account password — see [Authentication](authentication.md). Not allowed in config files.                                                                                                                                                                                              |
| `--client-id=<id>` / `--client-secret=<secret>`       | —              | OAuth2 credential, for `wrapido auth oauth2 login`/`add` — see [OAuth2](authentication-oauth2.md). Not allowed in config files.                                                                                                                                                                                                                                                                         |
| `--token=<token>`                                     | —              | OAuth2 personal access token, for `wrapido auth oauth2 add`. Not allowed in config files.                                                                                                                                                                                                                                                                                                               |
| `--use-auth=env\|none\|application-passwords\|oauth2` | `use-auth`     | Pin credential resolution to one source, skipping the rest of the fallback chain — see [Authentication](authentication.md).                                                                                                                                                                                                                                                                        |
| `--context=view\|edit\|embed`                         | `context`      | Default `view`. Run `wrapido <namespace> <route>` to see which values a given route actually supports.                                                                                                                                                                                                                                                                                                  |
| `--format=table\|json\|csv\|yaml\|ids\|count\|raw`    | `format`       | Default `table`. Table cells are truncated to 50 characters, and nested objects/arrays show as `<object>`/`<array>` unless named via `--fields` (e.g. `--fields=title.rendered`). `count` prints the site total from the `X-WP-Total` response header when WordPress sends one, else the number of rows returned.                                                                                  |
| `--fields=<a,b,c>`                                    | —              | Limit output to specific fields (table/csv also accept dotted paths like `title.rendered`). Per-invocation only. Also sent to the API as `_fields` (except on `delete`) to trim the response, and still filtered locally for endpoints that ignore it.                                                                                                                                             |
| `--field=<name>`                                      | —              | Print a single field's raw value (supports dotted paths, e.g. `title.rendered`). Per-invocation only.                                                                                                                                                                                                                                                                                              |
| `--body=<json>`                                       | —              | Raw JSON request body for `create`/`update`, overriding/merged under `--field=` args. Per-invocation only.                                                                                                                                                                                                                                                                                         |
| `--timeout=<ms>`                                      | `timeout`      | Timeout for every HTTP request; when given it replaces all the defaults below. Defaults: 20000 (20 s) for API calls, 8000 for site discovery and `wrapido auth` calls, and 300000 (5 min) for file uploads/downloads, where it is an idle timeout that resets whenever data moves.                                                                                                                      |
| `--no-color`                                          | `color: false` | Disable colored output. Also off when `NO_COLOR` is set or agent mode is on.                                                                                                                                                                                                                                                                                                                       |
| `--no-truncate`                                       | —              | Show full table cell values instead of truncating them to 50 characters. Per-invocation only.                                                                                                                                                                                                                                                                                                      |
| `--quiet`                                             | `quiet`        | Suppress spinners.                                                                                                                                                                                                                                                                                                                                                                                 |
| `--debug`                                             | `debug`        | Print a stack trace on unexpected (non-API) errors, and log every HTTP request/response to stderr (with the `Authorization` header redacted) plus the config files loaded. API requests add `?_envelope=true` so WordPress returns its response headers (`X-WP-Total`, plugin headers such as Query Monitor's `X-QM-*`, ...), which are logged too; the body is unwrapped and output is unchanged. |
| `-h`, `--help`                                        | —              | Show help for the given namespace/route/verb, or the top-level help.                                                                                                                                                                                                                                                                                                                               |

Flags with a YAML key can be set in a [config file](configuration.md#yaml-config-files); a flag on the command line always wins.

Any other `--name=value` (or bare `--name`, treated as `--name=true`) is passed straight through as a WordPress REST API field or query argument — e.g. `--per_page=5`, `--title="Hello"`, `--force`. Run `wrapido <namespace> <route>` first to see exactly which ones a route accepts.

`list --per_page=-1` fetches **every** page. The REST API itself rejects `-1`, so the CLI works around it the same way Gutenberg's `api-fetch` does: it requests the route's own maximum page size (the `maximum` declared in its schema, usually `100`) and concatenates the pages, in parallel when `X-WP-TotalPages` is sent and otherwise by following `Link: rel="next"`. This only applies to routes that declare both `page` and `per_page`. A progress bar shows while the pages load (hidden by `--quiet`). `--page` is ignored alongside it, with a warning. `--format=count` still makes just one request, and a `per_page` below `-1` is rejected before anything is sent.

## Agent mode

Auto-detected inside Claude Code, OpenAI Codex, GitHub Copilot's agent tooling, Cline and Cursor (or set `WRAPIDO_AGENT=1` by hand): plain, machine-friendly output (JSON by default, no colour or spinners, JSON errors, unknown-flag warnings) without changing anything for interactive use. See [Agent mode](agent-mode.md).

## TLS certificates

The CLI does **not** verify HTTPS certificates, so sites with self-signed, expired or mismatched certificates (local and staging installs) work without extra flags. This applies to every request, including uploads and downloads. Because the server's identity isn't checked, avoid using it with real credentials over untrusted networks.

## Help

`wrapido help [<namespace> [<route...> [<verb>]]]` renders the same usage synopsis you'd see interactively, built dynamically from the site's live introspected schema, but never performs the underlying request.

## Uploading files

Mark a value with `@` to upload it, using the parameter name the endpoint expects: `wrapido wp/v2 media create --file=./cat.jpg`. See [Uploading files](uploading-files.md).
