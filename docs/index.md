---
tags:
  - cli
---

# wrapido

<!-- markdownlint-disable MD033 -->
<p align="center">
  <img src="assets/logo.svg" alt="wrapido logo" width="160" height="160" style="background:#000;border-radius:24px;padding:24px;">
</p>
<!-- markdownlint-enable MD033 -->

<!-- markdownlint-disable-next-line MD033 -->
**<u>W</u>ordPress <u>R</u>EST <u>API</u> <u>Do</u>er**: a fast CLI for any WordPress site.

A WP-CLI-style command line tool for talking to **any** WordPress site's REST API over HTTP — no PHP, no SSH, no WordPress install required locally.

It auto-discovers a site's REST API from just a URL, introspects routes the way `?_method=OPTIONS` does, and speaks WP-CLI's own `--format=`/`--fields=` conventions.

!!! note "Independent project"
    This is an independent project inspired by [wp-cli/restful](https://github.com/wp-cli/restful) and the [2016 "RESTful WP-CLI" update](https://make.wordpress.org/cli/2016/04/14/restful-wp-cli-update-3/), reimplemented as a standalone Node/TypeScript CLI that always talks to a real WordPress REST API over HTTP (rather than running inside WordPress/PHP).

## Why

WP-CLI itself needs PHP, SSH access, and a local WordPress install to run against a site. `wrapido` gives you the same familiar command shapes and output conventions (`--format=table|json|csv|yaml`, `--fields=`, `list`/`get`/`create`/`update`/`delete`) against **any** WordPress site that exposes its REST API — including sites you don't have server access to.

## Quick start

```sh
git clone https://github.com/spacedmonkey/wrapido.git
cd wrapido
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
- **Introspection** — `wrapido <namespace> <route>` shows a route's supported methods, args, and `--context` values via a live `OPTIONS` request.
- **CRUD verbs** — `list`/`get`/`create`/`update`/`delete`/`exists`/`generate`, mirroring WP-CLI's own resource commands but generically, for any namespace (core or plugin).
- **Meta commands** — `wrapido <namespace> <route> meta <add|update|get|list|delete|patch|pluck|clean-duplicates>`, mapped onto the REST API's `meta` object field.
- **Output formats** — `table` (default), `json`, `csv`, `yaml`, `ids`, `count`, `raw`, with `--fields=`/`--field=` selection.
- **Agent mode** — `WRAPIDO_AGENT=1` gives AI agents and scripts plain, compact JSON output, JSON errors and unknown-flag warnings, with no change for interactive use. See [Agent mode](agent-mode.md).
- **Authentication** — HTTP Basic Auth via WordPress core Application Passwords, or OAuth2 via the [WP-API/OAuth2](https://github.com/WP-API/OAuth2) plugin (browser flow, `client_credentials`, or a personal access token) — or plain `--username`/`--password` / `WP_USERNAME`/`WP_PASSWORD`. See [Authentication](authentication.md).

## Project links

- [GitHub repository](https://github.com/spacedmonkey/wrapido)
- [Issues](https://github.com/spacedmonkey/wrapido/issues)
- [License (MIT)](https://github.com/spacedmonkey/wrapido/blob/main/LICENSE)
- [Sponsor this project](https://github.com/sponsors/spacedmonkey) — via GitHub Sponsors
