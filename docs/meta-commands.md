---
tags:
  - meta
  - cli
---

# Meta commands

WP-CLI's `wp post meta` talks to the `wp_postmeta` table directly. Over the REST API there's no such table access — meta only exists as the `meta` object field on the parent resource (visible only for keys registered with `show_in_rest`), read via `GET` and written by `PATCH`ing `{ "meta": { ... } }` onto the resource.

Every subcommand below is a best-effort mapping onto that model rather than a literal port of WP-CLI's behavior:

| Subcommand | Usage | Description |
| --- | --- | --- |
| `add` | `meta add <id> <key> [<value>]` | Sets a meta value. REST has no separate "add" semantics for repeated values, so this behaves the same as `update`. |
| `update` | `meta update <id> <key> [<value>]` | Sets a meta value. |
| `get` | `meta get <id> <key>` | Reads a single meta key. |
| `list` | `meta list <id> [--keys=] [--orderby=] [--order=]` | Lists every meta key visible on this item over the REST API (meta not registered with `show_in_rest` is invisible here). |
| `delete` | `meta delete <id> [<key>] [<value>] [--all]` | Deletes a whole meta key, or — given `<value>` too — removes every entry matching that value from an array-type field. |
| `clean-duplicates` | `meta clean-duplicates <id> <key>` | Removes duplicate entries from an array-type (multi-value) meta field. A single-value field has no duplicates to remove. |
| `pluck` | `meta pluck <id> <key> <key-path>...` | Reads a nested value inside a structured meta field by key-path (client-side traversal — REST has no partial-read endpoint). |
| `patch` | `meta patch <action> <id> <key> <key-path>... [<value>]` | Modifies a nested value inside a structured meta field by key-path, without replacing the whole field (client-side traversal — REST has no partial-update endpoint). |

All meta subcommands accept `--format=` like any other command. The `meta` usage synopsis is only shown for a route whose create/update schema actually declares a `meta` argument.

Every write goes through the same underlying mechanism, whichever subcommand triggers it: fetch the parent resource, then `PUT` the whole thing back with a modified `meta` object — REST has no endpoint that patches a single meta value in isolation, which is also why `patch`/`pluck` exist as client-side key-path tools rather than server-side operations. A value you pass on the command line is parsed as JSON first (so `42`, `true`, and `["a","b"]` become their real types), falling back to a literal string only when it isn't valid JSON.
