# wp-rest-cli

A WP-CLI-style command line tool for talking to **any** WordPress site's REST API over HTTP — no PHP, no SSH, no WordPress install required locally.

It auto-discovers a site's REST API from just a URL, introspects routes the way `?_method=OPTIONS` does, and speaks WP-CLI's own `--format=`/`--fields=` conventions.

!!! note "Independent project"
    This is an independent project inspired by [wp-cli/restful](https://github.com/wp-cli/restful) and the [2016 "RESTful WP-CLI" update](https://make.wordpress.org/cli/2016/04/14/restful-wp-cli-update-3/), reimplemented as a standalone Node/TypeScript CLI that always talks to a real WordPress REST API over HTTP (rather than running inside WordPress/PHP).

## Why

WP-CLI itself needs PHP, SSH access, and a local WordPress install to run against a site. `wp-rest-cli` gives you the same familiar command shapes and output conventions (`--format=table|json|csv|yaml`, `--fields=`, `list`/`get`/`create`/`update`/`delete`) against **any** WordPress site that exposes its REST API — including sites you don't have server access to.

## Quick start

```sh
git clone https://github.com/spacedmonkey/wp-rest-cli.git
cd wp-rest-cli
npm install
npm run build

# Discover a site's REST API
./dist/cli.js --url=https://example.com

# List routes in a namespace
./dist/cli.js wp/v2 --url=https://example.com

# List posts as JSON
./dist/cli.js wp/v2 posts list --per_page=5 --format=json --url=https://example.com
```

See [Installation](installation.md) for development setup, [Usage](usage.md) for the full command grammar, and [Examples](examples.md) for more.

## What it can do

- **Discovery** — resolve a bare site URL to its REST API root the same way the browser/`Link` header does.
- **Introspection** — `wp <namespace> <route>` shows a route's supported methods, args, and `--context` values via a live `OPTIONS` request.
- **CRUD verbs** — `list`/`get`/`create`/`update`/`delete`/`exists`/`generate`, mirroring WP-CLI's own resource commands but generically, for any namespace (core or plugin).
- **Meta commands** — `wp <namespace> <route> meta <add|update|get|list|delete|patch|pluck|clean-duplicates>`, mapped onto the REST API's `meta` object field.
- **Output formats** — `table` (default), `json`, `csv`, `yaml`, `ids`, `count`, `raw`, with `--fields=`/`--field=` selection.
- **Authentication** — HTTP Basic Auth via WordPress core Application Passwords, or `--username`/`--password` / `WP_USERNAME`/`WP_PASSWORD`.

## Project links

- [GitHub repository](https://github.com/spacedmonkey/wp-rest-cli)
- [Issues](https://github.com/spacedmonkey/wp-rest-cli/issues)
- [License (MIT)](https://github.com/spacedmonkey/wp-rest-cli/blob/main/LICENSE)
