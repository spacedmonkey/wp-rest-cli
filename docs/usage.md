# Usage

## Command grammar

The whole CLI is one dynamic grammar built from whatever routes a site's REST API actually registers — there's no fixed command tree to memorize:

```text
wp                                                              # discover: list namespaces from the site's REST API index
wp <namespace>                                                  # list routes registered under that namespace
wp <namespace> <route>                                          # introspect: show the route's supported methods/args/context (an OPTIONS request)
wp <namespace> <route> list        [--page=] [--per_page=] [...]
wp <namespace> <route> get <id>
wp <namespace> <route> create      [--field=value...] [--body=<json>]
wp <namespace> <route> update <id> [--field=value...] [--body=<json>]
wp <namespace> <route> delete <id> [--force]
wp <namespace> <route> exists <id>
wp <namespace> <route> generate    [--count=<n>] [--field=value...]
wp <namespace> <route> meta <add|clean-duplicates|delete|get|list|patch|pluck|update> ...
wp help [<namespace> [<route...> [<verb>]]]                     # same shapes, but never performs the request
wp config get|set|clear
```

- `list`/`create`/`generate` don't take an `<id>` — everything after the verb is treated as `field=value` pairs.
- `get`/`update`/`delete`/`exists` require an `<id>` as the first token after the verb.
- `exists` reuses `get`'s request shape but reports success/failure instead of printing the resource: exit code `0` if the id exists, `1` if it doesn't (a `404`).
- `generate` isn't a single HTTP request — it loops `create` `--count` times, reusing the same fields for each item.
- A route registered under nested literal path segments (e.g. a theme's `global-styles/themes/(?P<stylesheet>%s)`) is addressed as separate words, the same way WP-CLI addresses nested commands — e.g. `wp wp/v2 global-styles themes get <stylesheet>`.

## Global flags

| Flag | Description |
| --- | --- |
| `--url=<site>` | WordPress site URL. Required unless a default is saved (`wp config set --url=`). |
| `--username=<user>` | Also via the `WP_USERNAME` env var. |
| `--password=<pass>` | Also via the `WP_PASSWORD` env var. A WordPress **Application Password** is strongly recommended over a real account password — see [Authentication](authentication.md). |
| `--client-id=<id>` / `--client-secret=<secret>` | OAuth2 credential, for `wp auth oauth2 login`/`add` — see [OAuth2](authentication-oauth2.md). |
| `--use-auth=env\|none\|application-passwords\|oauth2` | Pin credential resolution to one source, skipping the rest of the fallback chain — see [Authentication](authentication.md). |
| `--context=view\|edit\|embed` | Default `view`. Run `wp <namespace> <route>` to see which values a given route actually supports. |
| `--format=table\|json\|csv\|yaml\|ids\|count\|raw` | Default `table`. |
| `--fields=<a,b,c>` | Limit output to specific top-level fields. |
| `--field=<name>` | Print a single field's raw value (supports dotted paths, e.g. `title.rendered`). |
| `--body=<json>` | Raw JSON request body for `create`/`update`, overriding/merged under `--field=` args. |
| `--timeout=<ms>` | Timeout for every HTTP request; when given it replaces all the defaults below. Defaults: 20000 (20 s) for API calls, 8000 for site discovery and `wp auth` calls, and 300000 (5 min) for file uploads/downloads, where it is an idle timeout that resets whenever data moves. |
| `--no-color` | Disable colored output. |
| `--quiet` | Suppress spinners. |
| `--debug` | Print a stack trace on unexpected (non-API) errors, and log every HTTP request/response to stderr (with the `Authorization` header redacted). |

Any other `--name=value` (or bare `--name`, treated as `--name=true`) is passed straight through as a WordPress REST API field or query argument — e.g. `--per_page=5`, `--title="Hello"`, `--force`. Run `wp <namespace> <route>` first to see exactly which ones a route accepts.

## TLS certificates

The CLI does **not** verify HTTPS certificates, so sites with self-signed, expired or mismatched certificates (local and staging installs) work without extra flags. This applies to every request, including uploads and downloads. Because the server's identity isn't checked, avoid using it with real credentials over untrusted networks.

## Help

`wp help [<namespace> [<route...> [<verb>]]]` renders the same usage synopsis you'd see interactively, built dynamically from the site's live introspected schema, but never performs the underlying request.

## Uploading files

Mark a value with `@` to upload it, using the parameter name the endpoint expects: `wp wp/v2 media create --file=./cat.jpg`. See [Uploading files](uploading-files.md).
