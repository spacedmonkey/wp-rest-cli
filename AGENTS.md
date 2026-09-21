# Using wp-rest-cli from an AI agent

`wp-rest-cli` talks to any WordPress site's REST API over HTTP. Its command set is built from the site's live API, so **discover, don't guess**. Human docs: `docs/agent-mode.md`.

## 1. Turn on agent mode (once)

```sh
export WP_REST_CLI_AGENT=1
```

This is the single switch for machine use. With it set you get:

- `--format=json` by default, printed **compact** with `_links`/`_embedded` stripped (name them in `--fields` to keep them).
- No colour, no spinners. Data is on **stdout**; notices/warnings are plain lines on **stderr**.
- Errors as JSON on stderr: `{"error":{"message","code","status","params","hint"}}`. Local CLI errors carry only `message`; API errors add the rest and often a `hint`. Exit code is `1` on any failure.
- A stderr `Warning: --per-page is not a declared arg of this route; did you mean --per_page?` for `--name=value` args the route doesn't declare (typos are otherwise silently ignored by WordPress).

Without it, pass `--format=json --quiet --no-color` on every call instead. An explicit `--format` or a `format:` in a `wp-rest-cli.yml` still overrides the agent-mode default.

Also put the site in a `wp-rest-cli.yml` in the working directory (or pass `--url=<site>` each time):

```yaml
url: https://example.com
```

## 2. Authenticate headlessly

`auth ... login` opens a browser: humans only. Instead:

- Env vars `WP_USERNAME` + `WP_PASSWORD` (a WordPress Application Password). Preferred: `--password` leaks into shell history and `ps`.
- Or store once: `wp-rest-cli auth application-passwords add <url> --username=<u> --password=<app-password>`.

Stored credentials are used **implicitly** for that site. Use `--use-auth=none` to see what an anonymous visitor sees. An OAuth2 `client_credentials` token acts as user 0, so drafts and `--context=edit` still need a real user.

## 3. Best workflow: discover, then act

```sh
wp-rest-cli                                # namespaces
wp-rest-cli wp/v2                          # routes: [{route, verbs:[...], has_children}]
wp-rest-cli wp/v2 posts                    # the route: verbs, endpoints (args, types, enums, required[]), children[]
wp-rest-cli help wp/v2 posts create        # ONE verb's endpoint only (cheapest; ~9 KB vs ~15 KB for the whole route)
```

Then act with `list`, `get <id>`, `create`, `update <id>`, `delete <id>`, `exists <id>`, `generate`, `meta ...`:

```sh
wp-rest-cli wp/v2 posts list --per_page=5 --fields=id,date,title.rendered
wp-rest-cli wp/v2 posts create --title="Hello" --status=draft
wp-rest-cli wp/v2 posts update 12 --body='{"content":"..."}'   # --body for nested/complex payloads
```

Nested routes (e.g. `posts revisions`) appear in a route's `children` array, and as `has_children: true` in a namespace listing. Address them as separate words: `wp-rest-cli wp/v2 posts revisions get <post-id>` (revisions/autosaves need a real user).

Tips for fewer calls:

- Prefer `help <ns> <route> <verb> --format=json` over the bare route call; each endpoint carries a `required` array of arg names.
- Cheap counts: `list --format=count --per_page=1` prints the site total.
- To embed related data: `--_embed=true --fields=id,_embedded`.

- Read the schema once (`help <ns> <route> <verb> --format=json` is scoped to that verb's HTTP method) instead of trial and error.
- Trim output with `--fields=id,title.rendered` (dotted paths keep their nesting in JSON).
- For a long flat list, `--format=csv --fields=id,date,slug` is about half the size of JSON (nested values become dotted columns like `title.rendered`; use JSON when you need nesting). Trimming with `--fields` matters far more than the format: a full posts page is ~49 KB, the same page with 4 fields ~0.3 KB.
- Heed stderr warnings: a `Warning: ...` means an arg was ignored, so the result may not be what you asked for.
- Check `hint` in JSON errors before retrying.

## 4. Facts worth knowing

- Any `--name=value` that isn't a global flag is sent as a WordPress field/query arg. Reserved names: `url username password client-id client-secret token use-auth context format fields field body timeout color truncate quiet debug help`; use `--body` if an API field collides.
- `list --format=count` prints the site total (`X-WP-Total`) when sent, else the rows returned. Default `--per_page` is 10 (max 100), newest first. When more pages exist, stderr says `Page 1 of N (T total)`; use `--page=N`.
- `exists <id>` exits `1` for "not found" and still prints `{"exists":false}` on stdout. An unknown route or namespace exits `1` with `No such route`/`No such namespace` (a JSON error in agent mode).
- `--format=raw` is Node-inspect text, not JSON. `auth ... login` needs a browser (humans only).
- Nested routes are separate words: `wp-rest-cli wp/v2 posts revisions get <post-id>`.
- `types`, `taxonomies`, `statuses` list one row per entry, so `--fields=slug,name` works.
- Uploads: the flag is the endpoint's own parameter name (`--file=@/path/img.png` for core media).
- `--debug` logs every HTTP request (credentials redacted) to stderr.
- HTTPS certificates are **not verified**; don't use real credentials on untrusted networks.

Full docs: `docs/agent-mode.md`, `docs/usage.md`, `docs/authentication.md`, `docs/uploading-files.md`.
