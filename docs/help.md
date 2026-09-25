---
tags:
  - help
  - cli
---

# Help

Every namespace, route, and verb is self-documenting — help text is always built live from the site's own introspected schema (a real `OPTIONS` request), never a hardcoded synopsis. There are two independent ways to see it, and they render differently on purpose.

<!-- markdownlint-disable MD046 -->

=== "`wrapido help ...`"

    ```sh
    wrapido help wp/v2 posts create
    ```

    A dense `usage: ...` / `  or: ...` synopsis block — quick to scan, no section headers. **Never performs the underlying request**, at any depth: `wrapido help`, `wrapido help <namespace>`, `wrapido help <namespace> <route...>`, `wrapido help <namespace> <route...> <verb>`, and the `meta`/`meta <verb>` shapes are all safe to run against a live site.

=== "trailing `-h`/`--help`"

    ```sh
    wrapido wp/v2 posts create --help
    ```

    A full NAME/DESCRIPTION/SYNOPSIS/SUBCOMMANDS (or .../OPTIONS/EXAMPLES) page, matching real WP-CLI's own `wp post create --help` output style. Since arbitrary REST routes don't ship WP-CLI's hand-written description text, the DESCRIPTION/SUBCOMMANDS prose is templated from the verb and route names — only the argument list itself comes from the live schema.

<!-- markdownlint-enable MD046 -->

Both styles work at every level of the command grammar — bare, namespace, route, verb, and `meta` — so `wrapido <namespace>`, `wrapido <namespace> <route>`, and `wrapido <namespace> <route> <verb> --help` all produce the matching page for that depth.

## Reading the argument list

Endpoint arguments are formatted the way real WP-CLI presents its own `OPTIONS`:

<!-- markdownlint-disable-next-line MD046 -->
```text
[--status=<string>]
    Description of the field, straight from the schema.
    ---
    default: draft
    options:
      - draft
      - publish
      - pending
    ---
```

- `<type>` (not the argument's name) is the placeholder, since — unlike a real WP-CLI command — a REST route's fields aren't known ahead of time.
- A required argument is shown bare (`--title=<string>`, no brackets).
- `default:`/`options:` blocks only appear when the schema actually declares them.
- `update`/`generate` borrow the `create` (`POST`) schema for their argument list — WordPress doesn't expose a separate schema for the item-level `PUT` endpoint, so this is the closest available approximation. Don't be surprised if an `update`'s listed options include a field the item endpoint doesn't actually accept.

## Listing children

A bare `wrapido`/`wrapido <namespace>`/`wrapido <namespace> <route>` (or their `wrapido help` equivalents) with `--format=table` (the default) renders a child listing in WP-CLI's own row style — label, then its supported verbs, no per-row description (there isn't one to show):

<!-- markdownlint-disable-next-line MD046 -->
```text
NAME

  wrapido wp/v2

DESCRIPTION

  Routes registered under the wp/v2 namespace.

SYNOPSIS

  wrapido wp/v2 <route> [<verb>] [<args>]

SUBCOMMANDS

  posts                list, get, create, update, delete, generate
  global-styles         (subcommand)
```

- A **pure container** route — one with no schema of its own, only deeper routes registered beneath it (e.g. `global-styles` before its `themes` child is addressed) — gets this same full NAME/DESCRIPTION/SYNOPSIS/SUBCOMMANDS page, one level deeper.
- A **hybrid** route — directly addressable *and* a container for further children — gets its own regular schema output first, with just the child rows appended afterward (no repeated headers, since the page above it already has them).
- Any other `--format` (`json`, `yaml`, ...) skips this page entirely and returns the plain `{route, verbs}` rows instead — see below.

## `--format=json` and other structured formats

<!-- markdownlint-disable-next-line MD046 -->
```sh
wrapido help wp/v2 posts --format=json
```

Any non-table format returns a structured object (`routeHelpObject`) instead of a text page — the same shape a normal `wrapido <namespace> <route>` introspection returns, just without ever making the live request that a bare (non-`help`) invocation would also skip anyway. [Agent mode](agent-mode.md#what-changes) documents the more compact shape this takes when `WRAPIDO_AGENT=1` is set (no bulky item `schema`, `endpoints[].required`, `verbs` as an array, `has_children`).

## Paging

Long help output — a namespace with many routes, a route with many arguments — pages through `less`/`$PAGER` the same as any other command's output, when run at a real terminal. See [Paging output](configuration.md#paging-output) for how to control that (`--no-pager`, `WRAPIDO_PAGER`/`PAGER`, or agent mode, which always disables it).

## `auth --help`

<!-- markdownlint-disable-next-line MD046 -->
```sh
wrapido auth --help
wrapido auth oauth2 --help
```

`wrapido auth` and each `wrapido auth <type>` have their own dedicated usage text, validating `<type>` the same way a real `wrapido auth <type> ...` invocation would (an unknown type is still an error under `--help`).
