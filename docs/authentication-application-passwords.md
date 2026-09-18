# Application Passwords

WordPress core's own authentication mechanism (Users → Profile → Application Passwords, built in since 5.6) — revocable and scoped per-application, over the same HTTP Basic Auth the CLI always sends. See [Authentication](authentication.md) for the general `--username`/`--password`/env-var/`--use-auth` precedence shared by both auth types.

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

`list`'s table columns are the credential's raw stored fields: `authMethod` is `application-password` or `password` (see [verification](#verification-on-wp-auth-application-passwords-add) below), and `default` shows `*` next to whichever site is currently the default `--url` (set via `use`, or `wp config set --url=`).

## Verification on `wp auth application-passwords add`

`wp auth application-passwords add` verifies a manually-supplied credential against the site before saving it: it checks whether the credential is actually an Application Password (and captures its uuid, for revocation — see below) and otherwise falls back to a generic authenticated request. Credentials the site conclusively rejects (401/403) are not saved. Pass `--skip-verify` to save without any of this checking (no network call at all) — useful for a site that's temporarily unreachable, or that rejects the verification request for its own unrelated reasons:

```sh
wp-rest-cli auth application-passwords add https://example.com --username=admin --password="wrong" --skip-verify
```

## Revocation on `remove` and re-`login`

When a stored credential is confirmed to be a WordPress Application Password (its uuid was captured at `wp auth application-passwords login`/`add` time), `wp auth application-passwords remove` — and a re-run of `login` for the same site, which replaces the old credential — also revokes it on the site itself (`DELETE /wp/v2/users/me/application-passwords/<uuid>`), not just locally. This is a best-effort step: an unreachable or since-changed site never blocks the local removal, and the command's output says explicitly whether the remote revocation succeeded.

This only applies to credentials this tool itself confirmed as an Application Password — a credential stored as a plain `password`-type (including one saved with `--skip-verify`, or by a version of this tool before this feature existed) has no uuid to revoke, and `remove`/`login` say so rather than silently doing nothing.

## The browser login flow (`wp auth application-passwords login`)

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
