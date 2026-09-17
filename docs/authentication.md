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

`WP_USERNAME`/`WP_PASSWORD` take precedence over a stored `wp auth` credential for the same site (see below) — if both are set, the env vars win on every command, silently, with no per-invocation indication that's happening. If that's not what you want (e.g. the env vars are left over from something else, or set globally in your shell), pin resolution to the stored credential with `--use-auth=application-passwords`:

```sh
wp-rest-cli wp/v2 posts list --url=https://example.com --use-auth=application-passwords
```

`--use-auth` names a `wp auth` type (`application-passwords` or `oauth2` — see [OAuth2](#oauth2) below) rather than a generic "stored", since a site can have a credential of each type stored at once — it's the same value `wp auth <type> ...` uses, and errors immediately if nothing of that type is stored rather than silently falling through to anonymous. `--use-auth=env` is the mirror image (require the env vars, error if they're unset); `--use-auth=none` forces an anonymous request even if env vars or a stored credential exist. An explicit `--username`/`--password` flag still overrides everything, `--use-auth` included.

## Stored credentials (`wp auth`)

You can also store a username/password (or Application Password) per site, so `--username`/`--password` don't need to be repeated on every invocation for sites you use often. Every `wp auth` command takes an explicit `<type>` naming which authentication mechanism to use — matching the literal key the site's REST API index advertises it under in its `authentication` object. `application-passwords` is documented here; `oauth2` (a second, independent credential a site can hold at the same time) is documented separately below.

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

Once stored, a site's credential is used automatically whenever you run a command against it without `--username`/`--password`. Precedence is: `--username`/`--password` flags; then, if `--use-auth` names a specific type (`application-passwords` or `oauth2`), that type's stored credential exactly (erroring if none is stored, rather than falling through); then `WP_USERNAME`/`WP_PASSWORD` env vars; then a stored `wp auth` credential for that site — if **both** an application-passwords and an oauth2 credential are stored and `--use-auth` wasn't given, this step is a fail-fast error naming both `--use-auth` values, rather than a silent guess (see [OAuth2 → Using a specific stored credential](#using-a-specific-stored-credential---use-auth)); then anonymous.

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

### Auth types

`<type>` isn't optional flourish — it's how this tool tells one authentication mechanism apart from another, both in the command grammar and, not coincidentally, in the same vocabulary WordPress (and the WP-API/OAuth2 plugin) itself uses: `application-passwords`/`oauth2` are the exact keys the site's REST API root index reports each feature under in its `authentication` object. A site can have **both** an application-passwords and an oauth2 credential stored at once — see [OAuth2](#oauth2) below for how that's disambiguated.

## OAuth2

The second supported `<type>` is `oauth2`, using the [WP-API/OAuth2](https://github.com/WP-API/OAuth2) WordPress plugin. It follows the same shape as `application-passwords` — `login`/`add`/`list`/`remove`/`use`/`status` — with different fields, since OAuth2's credential shape (a client id/secret) is different from a username/password pair.

### Prerequisite: creating an Application in wp-admin

Unlike Application Passwords' self-service `authorize-application.php` page, an OAuth2 "Application" (a `client_id`/`client_secret`/redirect URI, plus which grants it's allowed to use) has **no self-service equivalent** — it must be created by hand in wp-admin (**Users → Applications**, requires the `edit_users` capability) before `oauth2 login`/`oauth2 add` can be used at all. This tool cannot automate that step.

When creating the Application:

- Set its redirect URI to `http://127.0.0.1:8787/callback` (the default `wp auth oauth2 login` uses), unless you plan to override it with `redirect-uri=`/`port=` (see below) — the plugin matches this exactly, so it must match whatever the CLI is told to use.
- To use `wp auth oauth2 add` (see below), also enable **"Client Credentials Grant"** ("Allow this application to obtain tokens using the client_credentials grant.") on the Application.

### `wp auth oauth2 login` — browser flow (`authorization_code`)

```sh
wp-rest-cli auth oauth2 login https://example.com client-id=<your-client-id>
```

Runs the same kind of browser-based flow as `auth application-passwords login`: prints a URL, you open it and approve, and the CLI picks up the resulting access token via a local callback server. Unlike Application Passwords' OS-assigned ephemeral port, this binds to a **fixed** local address (`http://127.0.0.1:8787/callback` by default) — the plugin requires an exact redirect-URI match, so it has to be known ahead of time, not chosen at random each run. Override it with optional `redirect-uri=<uri>`/`port=<port>` fields if 8787 is taken or you registered a different one. `client-secret=<secret>` is also accepted but optional for this grant.

### `wp auth oauth2 add` — no browser (`client_credentials`)

```sh
wp-rest-cli auth oauth2 add https://example.com client-id=<your-client-id> client-secret=<your-client-secret>
```

Exchanges a client id/secret directly for a token, no browser involved — requires the Application to have the "Client Credentials Grant" setting enabled (see above); the CLI reports a clear error naming that setting if the exchange fails. Both `client-id=`/`client-secret=` are required here (unlike `login`, where the plugin doesn't enforce a secret for `authorization_code`).

### Managing stored OAuth2 credentials

```sh
wp-rest-cli auth oauth2 list      # every stored site's client id and grant type, never the access token
wp-rest-cli auth oauth2 use https://example.com
wp-rest-cli auth oauth2 status
wp-rest-cli auth oauth2 remove https://example.com
wp-rest-cli auth oauth2 remove --all
```

### Limitations

- **No expiry, no refresh.** The plugin issues tokens that never expire and has no `refresh_token` grant — this is spec-legal (RFC 6749 doesn't require either), not a bug in this tool.
- **No REST-based revocation.** Unlike Application Passwords, the plugin exposes no HTTP endpoint to revoke a token. `oauth2 remove` only forgets the credential locally — revoke it manually in wp-admin if needed.
- **No self-service client registration** — see the prerequisite above.
- **A `client_credentials` token has no real user context** (it authenticates as user id 0). Some routes' permission callbacks may reject it regardless of validity — `oauth2 add`'s own best-effort verification treats this as inconclusive, not a failure, and still saves the credential.
- **TLS is required**, even though the plugin itself doesn't enforce it (RFC 6749 requires TLS for both the authorization and token endpoints, and specifically for password-based client authentication — i.e. `add`'s client secret). `oauth2 login`/`add` both refuse a plain-HTTP, non-loopback site with a clear error, the same way `application-passwords login` already does.
- Both `oauth2 login` and `oauth2 add` check the site's discovery data first and refuse to proceed — no browser tab, no local server, no network request at all — with a clear message if the site doesn't advertise OAuth2 support (the plugin likely isn't installed or active), mirroring how `application-passwords login` behaves when Application Passwords support is absent.

### Using a specific stored credential (`--use-auth`)

Since a site can have both an application-passwords and an oauth2 credential stored, running an ordinary command with **neither** flags/env vars nor `--use-auth` given, and **both** types stored for that site, is an error rather than a silent guess:

```sh
$ wp-rest-cli wp/v2 posts list --url=https://example.com
Error: Both an application-passwords and an oauth2 credential are stored for https://example.com —
pass --use-auth=application-passwords or --use-auth=oauth2 to disambiguate.

$ wp-rest-cli wp/v2 posts list --url=https://example.com --use-auth=oauth2
```

## How it's built

Auth is implemented behind a small `AuthProvider` interface — `BasicAuthProvider` (Application Passwords/plain passwords) and `OAuth2AuthProvider` (OAuth2 bearer tokens) today — so each mechanism stays independent of request-building code.

One level up, `wp auth <type> ...`'s own dispatch is built the same way: `AuthType` is a real TypeScript union, and `commands/auth.ts`'s top-level switch on it is exhaustively checked — adding a further type without a matching dispatch case is a compile error, not just a missed spot.
