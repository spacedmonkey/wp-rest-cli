---
name: add-cli-verb
description: Add a new top-level verb to wp-rest-cli (like list/get/create/exists/generate), or change how an existing one is parsed, dispatched, or documented. Use when the user asks to add a new command/verb to the CLI, change verb argument handling, or add a new WP-CLI-style operation (e.g. "add a wp post touch-style verb", "add a verb that does X").
---

# Adding a top-level verb to wp-rest-cli

A "verb" here is one of `list`/`get`/`create`/`update`/`delete`/`exists`/`generate` — the token that follows `<namespace> <route>` in `wp-rest-cli <namespace> <route> <verb> ...`. Adding one touches several files that all need to agree; missing one produces a confusing partial feature (e.g. it parses but the help text is wrong, or it typechecks but `buildVerbRequest`'s switch silently doesn't cover it).

## Decide the verb's shape first

Before touching code, work out:
1. **Does it map to exactly one HTTP request?** (`list`→GET collection, `get`→GET item, `create`→POST collection, `update`→PUT item, `delete`→DELETE item, `exists`→GET item with 404 caught specially.) If yes, it belongs in `core/verbs.ts`'s `SingleRequestVerb` union and `buildVerbRequest`'s switch.
2. **Or does it need to loop / do something other than one request?** Like `generate`, which calls `create` N times. These verbs are *excluded* from `SingleRequestVerb` (see `Exclude<Verb, 'generate'>` in `core/verbs.ts`) and are special-cased directly in `runRestCommand` in `src/commands/rest.ts`, intercepted **before** the generic `buildVerbRequest` call at the bottom of that function.
3. **Does it need an `<id>`?** If yes it joins the `get`/`update`/`delete`/`exists` group in a couple of places below.

## Checklist (all of these, in order)

1. **`src/types.ts`** — add the verb to the `Verb` union.
2. **`src/core/verbs.ts`** (only if it maps to one HTTP request):
   - Add it to `METHOD_BY_VERB` (`Record<SingleRequestVerb, ...>`).
   - Add it to `REQUIRES_ID` if it needs an `<id>`.
   - Add a `case` in `buildVerbRequest`'s switch. If it doesn't belong in `SingleRequestVerb` (loop-style verb), skip this file entirely — TS will force you to handle exhaustiveness correctly since `BuildRequestOptions.verb: SingleRequestVerb`.
3. **`src/commands/rest.ts`**:
   - Add it to the local `VERBS: Verb[]` array. This is what `consumeRouteSegments` stops at when consuming route tokens, and what drives the "usage:/or:" iteration in `printRouteUsage` — order in this array is the order verbs are listed in help output.
   - If it needs an `<id>`, add it to the `if (verb === 'get' || verb === 'update' || ...)` branch in `parseCommandArgs` (the one that shifts the next token off as `id` and throws if missing/looks like a `field=value`).
   - Add a `case` to `buildVerbSynopsis` returning its one-line WP-CLI-style synopsis (e.g. `` `${base} <id>` ``, or reuse `formatArgsInline(endpoint?.args)` if it should show real schema args — see how `create`/`update` do this via `COLLECTION_VERB_METHOD`).
   - If its synopsis should show real argument names, add it to `COLLECTION_VERB_METHOD` (mapping it to `'GET'`/`'POST'` — whichever collection endpoint's schema is the closest approximation) and update the label logic in `printVerbHelp` if the generic label ("accepts:") isn't quite right for it (see how `update`/`generate` get a "(same writable fields as create)" qualifier there).
   - If it's a loop-style verb (not in `SingleRequestVerb`), add its execution branch in `runRestCommand` **before** the final generic `buildVerbRequest({ verb: parsed.verb, ... })` call, with its own early `return`. Look at the `generate` branch for the pattern: parse any verb-specific pseudo-fields out of `parsed.fields` first (e.g. `generate` pulls out `count` before passing the rest through as create fields), run the loop/special logic, then reuse `formatOutput` for non-default `--format` output and a `pc.green('Success: ...')` line for the default table case.
   - If it's a single-request verb with special *response handling* (like `exists` turning a 404 into exit code 1 instead of an error), add its branch the same way, also before the generic dispatch — `exists` is the template: call `buildVerbRequest`, `try`/`catch` around the actual `client.request`, check `error instanceof WpApiError && error.status === 404` specifically (rethrow anything else), and support both the default `Success:`/exit-code path and a structured `--format=json`-style path.
   - If the verb should never actually reach `buildVerbRequest` (loop-style), make sure your early-return `if` blocks are unconditional returns — TypeScript narrows `parsed.verb`'s type through them, so the final generic dispatch stays type-safe against `SingleRequestVerb` without a cast.
4. **`README.md`** — add the verb to the "Command grammar" block and, if it needs one, an example under `## Examples`.
5. **Tests** — this is not optional; see `extend-fixture-server` skill for the fixture side. At minimum add:
   - A case in `test/unit/parse-command-args.test.ts` if you changed parsing behavior.
   - One or more `it()` blocks in `test/integration/cli.test.ts` exercising the verb end-to-end against the fixture server (`wp/v2 widgets <verb> ...`), covering the success path and at least one failure/edge case.

## Gotchas from past additions

- `parseHelpArgs`/`runHelpCommand` reuse the *same* `VERBS`/`consumeRouteSegments` machinery as the main dispatch, so `wp-rest-cli help <namespace> <route> <verb>` generally works automatically once the verb is in `VERBS` and `buildVerbSynopsis` — you don't need to touch `runHelpCommand` for a normal verb. You only touch it if the verb needs bespoke help behavior beyond `printVerbHelp`.
- `npx tsc --noEmit` will catch most of the coordination mistakes (missing switch case, `Verb` union mismatch) — run it after step 3, not just at the end.
- Run `npx prettier --write` on whatever you touched; this codebase enforces Prettier formatting and CI-equivalent (`npm run lint`) will flag anything unformatted.
