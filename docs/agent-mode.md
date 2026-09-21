# Agent mode

`wp-rest-cli` pairs well with AI agents (Claude Code, Codex, scripts): once auth is set up, an agent can discover a site's REST API and build content with it. **Agent mode** makes the output easy for a program to read, and changes nothing for people at a terminal.

## Turn it on

```sh
export WP_REST_CLI_AGENT=1
```

Any value except empty, `0`, `false`, `no` or `off` enables it. Unset, the CLI behaves exactly as documented elsewhere.

## What changes

| Behaviour | Normal | With `WP_REST_CLI_AGENT=1` |
| --- | --- | --- |
| Default `--format` | `table` | `json` (a `format` in a [config file](configuration.md) or an explicit `--format` still wins) |
| JSON layout | Indented | Compact, one line |
| `_links` / `_embedded` | Kept | Removed from json/yaml/raw output (kept if you name them in `--fields`) |
| Colour | On | Off |
| Spinners | On | Off; notices are plain lines on stderr |
| Route discovery JSON | Raw OPTIONS response (`wp <ns> <route>`); `verbs` as a `"list, get, (subcommand)"` string | Same object as `help` (no bulky item `schema`; `endpoints[].required`, `children[]`); `verbs` as an array plus `has_children` |
| Errors | `Error: ...` text | JSON on stderr, for every error (including a bad `--format`): `{"error":{"message","code","status","params","hint"}}` |
| Unknown `--name=value` | Silently sent to the API | Warning on stderr, with a suggestion (`--per-page` → `--per_page`) |

JSON is the default because it is the only format that is lossless for every command's output (nested objects, single items, schemas, errors). For a long, flat list, `--format=csv --fields=...` is roughly half the size; and `--fields` trimming matters far more than the format.

Data always goes to stdout and notices to stderr, so `2>/dev/null` gives clean data.

## Works in any mode

These help agents but are available to everyone:

- `wp help <namespace> <route> [<verb>] --format=json` — structured schema (args, types, enums), scoped to the verb's HTTP method.
- `--format=json` prints errors as JSON.
- `help ... --format=json` includes each endpoint's `required` arg names and the route's nested `children`.
- `--fields=id,_embedded` also asks WordPress for `_links` (needed for `--_embed` to work).
- `list --format=count` prints the site total (from `X-WP-Total`); when more pages exist, stderr says `Page 1 of N (T total)`.
- An unknown route exits `1` with `No such route`, and a bare unknown namespace with `No such namespace` (in agent mode this also applies when a verb is given).
- `--fields=id,title.rendered` keeps nesting in JSON/YAML.
- `types`, `taxonomies` and `statuses` list one row per entry.

## Authentication for agents

`auth ... login` opens a browser, so it is for humans. Headless options:

- `WP_USERNAME` + `WP_PASSWORD` environment variables (a WordPress [Application Password](authentication-application-passwords.md)) — preferred, since `--password` leaks into shell history and the process list.
- Store once with `wp auth application-passwords add <url> --username=<u> --password=<app-password>`.

Stored credentials are used implicitly for that site. Use `--use-auth=none` to see what an anonymous visitor sees. An OAuth2 `client_credentials` token acts as user 0, so drafts and `--context=edit` still need a real user.

## Recommended setup

Put a `wp-rest-cli.yml` next to the agent's working directory so it never has to repeat the site:

```yaml
url: https://example.com
```

and export `WP_REST_CLI_AGENT=1` in the agent's environment. Point the agent at [AGENTS.md](https://github.com/spacedmonkey/wp-rest-cli/blob/main/AGENTS.md), which is written for it.
