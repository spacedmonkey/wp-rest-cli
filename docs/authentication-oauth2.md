# OAuth2

The second supported `<type>` is `oauth2`, using the [WP-API/OAuth2](https://github.com/WP-API/OAuth2) WordPress plugin. It follows the same shape as [Application Passwords](authentication-application-passwords.md) — `login`/`add`/`list`/`remove`/`use`/`status` — with `--client-id`/`--client-secret` (or `--token`, for a personal access token — see below) playing the same role `--username`/`--password` do there. See [Authentication](authentication.md) for the general `--username`/`--password`/env-var/`--use-auth` precedence shared by both auth types.

!!! note "No need to repeat --url"
    `<url>` — the site the credential is *for* — is optional as a positional argument on `login`/`add`/`remove`/`use`: if you omit it, it falls back to the global `--url` flag (or a saved default from `wrapido config set --url=`), the same way every other command already resolves which site to talk to. So there's no need to pass both:
    ```sh
    wrapido auth oauth2 add --url=https://example.com --client-id=<id> --client-secret=<secret>
    ```
    An explicit positional `<url>` still wins if you do pass one — useful for managing a credential for a *different* site than the one `--url` points at.

## Prerequisite: creating an Application in wp-admin

Unlike Application Passwords' self-service `authorize-application.php` page, an OAuth2 "Application" (a `client_id`/`client_secret`/redirect URI, plus which grants it's allowed to use) has **no self-service equivalent** — it must be created by hand in wp-admin (**Users → Applications**, requires the `edit_users` capability) before `oauth2 login`/`oauth2 add` can be used at all. This tool cannot automate that step.

When creating the Application:

- Set its redirect URI to `http://127.0.0.1:8787/callback` (the default `wrapido auth oauth2 login` uses), unless you plan to override it with the `redirect-uri=`/`port=` fields (see below) — the plugin matches this exactly, so it must match whatever the CLI is told to use.
- To use `wrapido auth oauth2 add` (see below), also enable **"Client Credentials Grant"** ("Allow this application to obtain tokens using the client_credentials grant.") on the Application. **This checkbox only exists on a recent-enough build of the plugin** — see [Requires a recent plugin version](#requires-a-recent-plugin-version) below before assuming it's missing by mistake.

## `wrapido auth oauth2 login` — browser flow (`authorization_code`)

```sh
wrapido auth oauth2 login https://example.com --client-id=<your-client-id>
```

Runs the same kind of browser-based flow as `auth application-passwords login`: prints a URL, you open it and approve, and the CLI picks up the resulting access token via a local callback server. Unlike Application Passwords' OS-assigned ephemeral port, this binds to a **fixed** local address (`http://127.0.0.1:8787/callback` by default) — the plugin requires an exact redirect-URI match, so it has to be known ahead of time, not chosen at random each run. Override it with optional `redirect-uri=<uri>`/`port=<port>` fields if 8787 is taken or you registered a different one. `--client-secret=<secret>` is also accepted but optional for this grant.

## `wrapido auth oauth2 add` — no browser, client credentials (`client_credentials`)

```sh
wrapido auth oauth2 add https://example.com --client-id=<your-client-id> --client-secret=<your-client-secret>
```

Exchanges a client id/secret directly for a token, no browser involved — requires the Application to have the "Client Credentials Grant" setting enabled (see above); the CLI reports a clear error naming that setting if the exchange fails. Both `--client-id`/`--client-secret` are required here (unlike `login`, where the plugin doesn't enforce a secret for `authorization_code`).

### Requires a recent plugin version

`client_credentials` support (the grant `wrapido auth oauth2 add` uses) was added to the WP-API/OAuth2 plugin on **2026-02-16** (commit `5e75343140`). A site running an older install — including anything from before that date — has **no `client_credentials` support at all**: no "Client Credentials Grant" checkbox on the Application screen, and no code path to handle the request. `wrapido auth oauth2 login` (`authorization_code`) is unaffected and has worked since long before this — if `add` won't cooperate, `login` is a good way to confirm the rest of your setup (Application, client-id, redirect URI) is otherwise fine.

If `oauth2 add` fails with an error mentioning that the site "responded as though this were an `authorization_code` request instead", or with a raw `Missing parameter(s): client_id, code` / `Invalid parameter(s): grant_type` error, that's this exact situation — the request never reached the plugin's `client_credentials` handling at all, because that handling doesn't exist in the deployed code. This is a different failure from (and easy to mistake for) the "grant not enabled" case, which instead shows a distinct "the site rejected these credentials" message. **No client-id/client-secret combination will ever fix the first kind of error** — the plugin itself needs updating.

The plugin has no tagged releases, so most installs track it as a Composer `dev-master` (or similar `dev-*`) requirement. This is the single most common way to end up on a version that predates `client_credentials` without realizing it: **`composer install` always installs the exact commit recorded in `composer.lock`**, not whatever `dev-master` currently resolves to upstream — a lock file generated once, long ago, and never refreshed for this package will keep reinstalling that same old commit indefinitely, no matter how many new commits land on the plugin's real `master` branch. To pick up the current code:

```sh
composer update wp-api/oauth2
```

To pin to a known-good commit deliberately (recommended, since this plugin has no version tags to pin to instead), use Composer's branch-plus-reference syntax in `composer.json`:

```json
"require": {
    "wp-api/oauth2": "dev-master#<commit-sha>"
}
```

...then run `composer update wp-api/oauth2` again and commit the updated `composer.lock`.

## `wrapido auth oauth2 add` — no browser, personal access token

```sh
wrapido auth oauth2 add https://example.com --token=<your-personal-token>
```

For a plugin build/fork that supports personal access tokens — generated by hand on a wp-admin screen, the same mental model as an Application Password, but sent as an `Authorization: Bearer <token>` header instead of HTTP Basic. There's no `client_id`/`client_secret` and no Application to create in wp-admin for this path — just paste the token in. `--token` is mutually exclusive with `--client-id`/`--client-secret`; passing both is an error.

By default, `add` verifies the token against the site (`GET wp/v2/users/me`) before saving it, and refuses to save one the site conclusively rejects (401/403):

```sh
$ wrapido auth oauth2 add https://example.com --token=wrong
Error: This personal token was rejected by the site — pass skip-verify=true to save anyway.
```

Pass `skip-verify=true` to skip that check and save the token regardless (useful if the site is temporarily unreachable, or you know the token is fine and don't want the extra request):

```sh
wrapido auth oauth2 add https://example.com --token=<your-personal-token> skip-verify=true
```

Unlike a `client_credentials` token (which authenticates as user id 0, so verification failure is only ever a warning — see above), a personal token authenticates as a real user, so an unambiguous rejection blocks the save rather than just warning.

## Managing stored OAuth2 credentials

```sh
wrapido auth oauth2 list      # every stored site's client id (blank for a personal token) and grant type, never the access token
wrapido auth oauth2 use https://example.com
wrapido auth oauth2 status
wrapido auth oauth2 remove https://example.com
wrapido auth oauth2 remove --all
```

## Limitations

- **No expiry, no refresh.** The plugin issues tokens that never expire and has no `refresh_token` grant — this is spec-legal (RFC 6749 doesn't require either), not a bug in this tool.
- **No REST-based revocation.** Unlike Application Passwords, the plugin exposes no HTTP endpoint to revoke a token. `oauth2 remove` only forgets the credential locally — revoke it manually in wp-admin if needed. This applies to a personal token too.
- **No self-service client registration** — see the prerequisite above. (Doesn't apply to a personal access token — see [personal access token](#wrapido-auth-oauth2-add--no-browser-personal-access-token) above — since there's no client/Application involved in that path at all.)
- **`client_credentials` requires a plugin version from 2026-02-16 or later** — see [Requires a recent plugin version](#requires-a-recent-plugin-version) above, including a Composer `dev-master`/`composer.lock` gotcha that's the most common way to be on an older version without realizing it.
- **A `client_credentials` token has no real user context** (it authenticates as user id 0). Some routes' permission callbacks may reject it regardless of validity — `oauth2 add`'s own best-effort verification treats this as inconclusive, not a failure, and still saves the credential. A personal token, by contrast, authenticates as whichever real user generated it, so `add`'s verification blocks the save on an unambiguous rejection instead.
- **TLS is required**, even though the plugin itself doesn't enforce it (RFC 6749 requires TLS for both the authorization and token endpoints, and specifically for password-based client authentication — i.e. `add`'s client secret). `oauth2 login`/`add` both refuse a plain-HTTP, non-loopback site with a clear error, the same way `application-passwords login` already does — this includes `add --token=`.
- Both `oauth2 login` and `oauth2 add --client-id=`/`--client-secret=` check the site's discovery data first and refuse to proceed — no browser tab, no local server, no network request at all — with a clear message if the site doesn't advertise OAuth2 support (the plugin likely isn't installed or active), mirroring how `application-passwords login` behaves when Application Passwords support is absent. `add --token=` doesn't perform this check — a personal token needs no token-endpoint support to be discovered, only the plain TLS check above.
