# Authentication

Use a WordPress core **Application Password** (Users → Profile → Application Passwords, built into WordPress since 5.6) rather than a real account password:

```sh
wp-rest-cli wp/v2 posts list \
  --url=https://example.com \
  --username=admin \
  --password="xxxx xxxx xxxx xxxx xxxx xxxx"
```

Application Passwords are revocable and scoped per-application, and work over the same HTTP Basic Auth the CLI always sends — nothing else about how you invoke the CLI changes if you use one.

Run `wp-rest-cli --url=<site>` to see whether a target site reports Application Password support (from its REST API index).

## Credentials via environment variables

```sh
export WP_USERNAME=admin
export WP_PASSWORD="xxxx xxxx xxxx xxxx xxxx xxxx"

wp-rest-cli wp/v2 posts list --url=https://example.com
```

## Stored credentials (`wp auth`)

You can also store a username/password (or Application Password) per site, so `--username`/`--password` don't need to be repeated on every invocation for sites you use often. Every `wp auth` command takes an explicit `<type>` naming which authentication mechanism to use — matching the literal key WordPress's own REST API index advertises it under in its `authentication` object. Today the only implemented type is `application-passwords`; the grammar leaves room for a future mechanism (e.g. `oauth2`) to be added as a sibling without changing anything about how `application-passwords` itself works:

```sh
# Store a manually-issued Application Password (or a real account password):
wp-rest-cli auth application-passwords add https://example.com --username=admin --password="xxxx xxxx xxxx xxxx xxxx xxxx"

# Or let wp-rest-cli obtain one for you, via a browser (see below):
wp-rest-cli auth application-passwords login https://example.com
wp-rest-cli auth application-passwords login https://example.com "app-name=my laptop"  # optional, defaults to "wp-rest-cli"

wp-rest-cli auth application-passwords list      # every stored site, without passwords
wp-rest-cli auth application-passwords use https://example.com   # make it the default --url
wp-rest-cli auth application-passwords status    # the default site, and whether a credential is stored for it
wp-rest-cli auth application-passwords remove https://example.com
wp-rest-cli auth application-passwords remove --all   # remove (and revoke where possible) every stored credential
```

Once stored, a site's credential is used automatically whenever you run a command against it without `--username`/`--password`. Precedence is: `--username`/`--password` flags, then `WP_USERNAME`/`WP_PASSWORD` env vars, then a stored `wp auth` credential for that site, then anonymous.

`list`'s table columns are the credential's raw stored fields: `authMethod` is `application-password` or `password` (see [verification](#verification-on-wp-auth-application-passwords-add) below), and `default` shows `*` next to whichever site is currently the default `--url` (set via `use`, or `wp config set --url=`).

### Verification on `wp auth application-passwords add`

`wp auth application-passwords add` verifies a manually-supplied credential against the site before saving it: it checks whether the credential is actually an Application Password (and captures its uuid, for revocation — see below) and otherwise falls back to a generic authenticated request. Credentials the site conclusively rejects (401/403) are not saved. Pass `--skip-verify` to save without any of this checking (no network call at all) — useful for a site that's temporarily unreachable, or that rejects the verification request for its own unrelated reasons:

```sh
wp-rest-cli auth application-passwords add https://example.com --username=admin --password="wrong" --skip-verify
```

### Revocation on `remove` and re-`login`

When a stored credential is confirmed to be a WordPress Application Password (its uuid was captured at `wp auth application-passwords login`/`add` time), `wp auth application-passwords remove` — and a re-run of `login` for the same site, which replaces the old credential — also revokes it on the site itself (`DELETE /wp/v2/users/me/application-passwords/<uuid>`), not just locally. This is a best-effort step: an unreachable or since-changed site never blocks the local removal, and the command's output says explicitly whether the remote revocation succeeded.

This only applies to credentials this tool itself confirmed as an Application Password — a credential stored as a plain `password`-type (including one saved with `--skip-verify`, or by a version of this tool before this feature existed) has no uuid to revoke, and `remove`/`login` say so rather than silently doing nothing.

!!! note "At-rest protection: a per-machine key file, not a secret vault"
    Stored credentials are encrypted on disk (via `conf`'s `encryptionKey`), using a random key generated once per machine and stored in its own file (`credential-key`, alongside the config file, restricted to the owner where the OS supports it) rather than a fixed key shipped in the CLI's source. That means a copied/leaked config file alone isn't enough to decrypt it — the separate key file is also needed. It does **not** protect against something that already has full read access to the same account (another process running as the same user, a compromised account, etc.) — that would need an OS keychain or secret manager, which is out of scope here. If a machine or its config is ever suspected compromised, use `wp config rotate-key` (rotates the local key, re-encrypting the existing store under it) and `wp auth application-passwords remove --all` (revokes what it can on each site, and forgets every stored credential) — see [Configuration](configuration.md).

### The browser login flow (`wp auth application-passwords login`)

`wp auth application-passwords login <url>` runs the same kind of flow as `gh auth login`/`claude login`: it prints a URL, you open it in your browser and approve, and the CLI picks up the resulting Application Password automatically — no copying and pasting a password.

```sh
$ wp-rest-cli auth application-passwords login https://example.com
Open this URL in your browser to authorize wp-rest-cli:

  https://example.com/wp-admin/authorize-application.php?app_name=wp-rest-cli&success_url=http%3A%2F%2F127.0.0.1%3A54321%2Fcallback

Waiting for authorization...
Success: Saved an Application Password for admin@https://example.com.
```

Behind the scenes, `wp-rest-cli` starts a short-lived HTTP server on a random `127.0.0.1` port and asks WordPress to redirect there once you approve, so the new credential never has to be typed or pasted anywhere. It waits up to 5 minutes for you to finish in the browser.

This requires the site to actually support WordPress core Application Passwords (WordPress 5.6+, with the feature enabled) — and WordPress itself only allows Application Passwords over **HTTPS** (except on `localhost`/`127.0.0.1`, for local development). If a site doesn't qualify, `login` explains why and points you at `add` as a fallback:

```sh
$ wp-rest-cli auth application-passwords login http://example.com
Error: This site does not advertise Application Passwords support. WordPress disables Application
Passwords over plain HTTP (except on localhost) — use an https:// URL, or store a regular account
password instead with: wp auth application-passwords add <url> --username=<u> --password=<p>
```

### Auth types and future mechanisms

`<type>` isn't optional flourish — it's how this tool tells one authentication mechanism apart from another, both in the command grammar and, not coincidentally, in the same vocabulary WordPress itself uses: `application-passwords` is the exact key WordPress's REST API root index reports this feature under in its `authentication` object. A future mechanism like OAuth2 would be added the same way — as a new `<type>` value with its own `login`/`add`/`list`/`remove`/`use`/`status` behavior — rather than requiring another change to the command shape. Passing an unimplemented but recognized type today (`wp auth oauth2 login <url>`) reports that it's planned but not yet available, rather than an opaque "unknown command" error.

## How it's built

Auth is implemented behind a small `AuthProvider` interface (`BasicAuthProvider` today), so other methods — OAuth, cookie/nonce auth, etc. — can be added later without touching request-building code. Application Passwords need no separate provider: they're wire-compatible with HTTP Basic Auth, so `BasicAuthProvider` handles both.

One level up, `wp auth <type> ...`'s own dispatch is built the same way: `AuthType` is a real TypeScript union (currently one member), and `commands/auth.ts`'s top-level switch on it is exhaustively checked — adding a second type without a matching dispatch case is a compile error, not just a missed spot.
