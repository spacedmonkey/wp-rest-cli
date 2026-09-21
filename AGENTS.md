# Using wp-rest-cli from an AI agent

`wp-rest-cli` talks to any WordPress site's REST API over HTTP. Its command set is built from the site's live API, so **discover, don't guess**.

## Setup (once)

Put a `wp-rest-cli.yml` in the working directory so you don't repeat flags:

```yaml
url: https://example.com
format: json
quiet: true
```

Auth (headless — `auth ... login` needs a browser and is for humans):

- Env vars `WP_USERNAME` + `WP_PASSWORD` (a WordPress Application Password). Prefer these to `--password`, which leaks into shell history and `ps`.
- Or store once: `wp-rest-cli auth application-passwords add <url> --username=<u> --password=<app-password>`.

## Discovery loop

```sh
wp-rest-cli                              # namespaces
wp-rest-cli wp/v2                        # routes in a namespace
wp-rest-cli wp/v2 posts                  # methods, fields, types, enums (--format=json for structured output)
wp-rest-cli help wp/v2 posts create      # one verb's fields (--format=json too)
```

Then act: `list`, `get <id>`, `create`, `update <id>`, `delete <id>`, `exists <id>`, `meta ...`.

```sh
wp-rest-cli wp/v2 posts create --title="Hello" --status=draft
wp-rest-cli wp/v2 posts update 12 --body='{"content":"..."}'   # --body for nested/complex payloads
```

## Rules of the road

- Always use `--format=json` (via the yml, or per call) and `--quiet`. Data is on stdout; spinners/notices are on stderr. Colour and spinners are off automatically when stdout/stderr aren't a TTY (or `NO_COLOR` is set); stderr then carries only plain notices.
- Stored credentials (`wp auth ... add/login`) are used **implicitly** for that site. Pass `--use-auth=none` to test what an anonymous visitor sees; a stored OAuth2 `client_credentials` token acts as user 0, not a real user.
- `--url=<site>` works on any command; the yml is just a convenience.
- Any `--name=value` that isn't a global flag is sent as a WordPress field/query arg. Reserved names: `url username password client-id client-secret token use-auth context format fields field body timeout color truncate quiet debug help` — use `--body` if an API field collides.
- Failures exit `1`; with `--format=json` stderr is `{"error":{...}}`: local CLI errors carry only `message`; API errors also carry `code`, `status`, `params` and often a `hint`. `exists` also exits `1` for "not found".
- Use `--fields=id,title.rendered` to keep output small (dotted paths keep their nesting in JSON: `{"id":1,"title":{"rendered":"..."}}`); `--debug` logs every HTTP request.
- `list --format=count` prints the site total (`X-WP-Total`) when WordPress sends it, else the rows returned. Default `--per_page` is 10 (max 100), default order is newest first. When more pages exist, stderr gets `Page 1 of N (T total)`; use `--page=N`.
- Unknown `--name=value` args and unknown `--fields` paths are not validated (a typo like `--per-page` is ignored), so check output shape.
- Drafts and `--context=edit` need a real user; an OAuth2 `client_credentials` token acts as user 0.
- To see what `create` accepts as JSON: `help <ns> <route> create --format=json` (scoped to that verb's POST endpoint).
- Slug-keyed endpoints (`types`, `taxonomies`, `statuses`) are listed one row per entry, so `--fields=slug,name` works.
- Nested routes are separate words: `wp-rest-cli wp/v2 posts revisions get <post-id>`.
- Table output truncates cells to 50 chars; use `--no-truncate` or `--format=json`.
- An unknown namespace or route exits `1` with `No such namespace`/`No such route`.
- Uploads: the flag is the endpoint's own parameter name (`--file=@/path/img.png` for core media).
- HTTPS certificates are **not verified**; don't use real credentials on untrusted networks.

Full docs: `docs/usage.md`, `docs/authentication.md`, `docs/uploading-files.md`.
