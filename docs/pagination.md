---
tags:
  - pagination
  - cli
---

# Pagination

`list` supports the usual `--page=<n>`/`--per_page=<n>` query args any WordPress REST collection accepts. `--per_page=-1` is special: WordPress itself rejects that value, but `wrapido` emulates "every item" the same way Gutenberg's own `api-fetch` `fetch-all-middleware` does, so you get the full collection without hand-rolling a paging loop.

```sh
wrapido wp/v2 posts list --per_page=-1 --format=ids --url=https://example.com
```

## How fetch-all works

1. **Page 1** is requested first, at the route's own maximum page size (its live schema's `per_page.maximum` — usually `100` — not a value the CLI invents).
2. If the response carries an `X-WP-TotalPages` header, the remaining pages are fetched **in parallel, 5 at a time**, and a progress bar tracks completion against that known total.
3. If `X-WP-TotalPages` is missing or non-numeric, the CLI instead follows `Link: rel="next"` headers **one page at a time** — there's no total to show a progress bar against, so a spinner runs instead (guarded against a self-referencing `Link` loop).
4. All pages are concatenated into one result before formatting/`--fields` selection runs, so `--per_page=-1` behaves like any other `list` from the output side — the fetching is the only part that's different.

<!-- markdownlint-disable MD046 -->

=== "X-WP-TotalPages present"

    ```text
    Fetching wp/v2 posts ⠋
    Fetching wp/v2 posts [====================] 12/12 pages
    ```

    5 requests in flight at once; the bar fills as each batch resolves.

=== "Link header only"

    ```text
    Fetching wp/v2 posts (following next links) ⠋
    ```

    One request after another — slower, but the only option WordPress gives when a route doesn't send `X-WP-TotalPages`.

<!-- markdownlint-enable MD046 -->

## Preconditions

The fetch-all shortcut only engages when the route's **live** schema declares both a `page` and a `per_page` argument:

- [x] The route's create/collection schema lists `page` and `per_page` (true for almost every core `wp/v2` collection).
- [ ] The route is one of `types`, `taxonomies`, or `statuses` — these return an **object keyed by slug**, not a paged array, so they're unpacked via `Object.values(...)` into rows instead and are never fetch-all candidates.

If `--per_page=-1` is given on a route that doesn't declare both args (often because it declares no query args at all), the CLI can't confirm the shortcut applies — `-1` is forwarded to the API exactly as typed, with a stderr notice explaining why:

```text
Notice: wp/my-plugin/v1 things doesn't declare page/per_page in its schema — sending --per_page=-1 to the API as-is.
```

## Interactions with other flags

| Flag/format            | Behavior with `--per_page=-1`                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `--page=<n>`             | Ignored, with a stderr notice — a page number is meaningless once every page is being fetched.                          |
| `--format=count`        | Skips the fetch-all loop entirely: one request for page 1, and the count comes from the `X-WP-Total` response header.    |
| `--per_page` below `-1` | Rejected locally before any request is sent: `--per_page must be -1 (all pages) or a positive integer.`                 |
| `--quiet`                | Hides the progress bar/spinner; the pages are still fetched.                                                            |

## Ordinary (non-`-1`) pagination

Without `--per_page=-1`, `list` just makes one request. If the route reports more pages than the one just fetched, a stderr notice tells you so:

```text
$ wrapido wp/v2 posts list --url=https://example.com
Page 1 of 4 (312 total). Use --page=<n> for more.
```

See [Routing](usage.md#routing) for how `types`/`taxonomies`/`statuses` list rows even though they aren't paginated collections, and [Agent mode](agent-mode.md#works-in-any-mode) for how `list --format=count`/`--per_page=-1` behave identically for scripted consumers.
