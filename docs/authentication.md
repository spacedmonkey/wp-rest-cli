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

## Saved defaults

`--url`/`--username` can be saved so you don't have to repeat them on every invocation (see [Configuration](configuration.md)). Passwords are **never** persisted — they must always come from `--password` or `WP_PASSWORD`.

## How it's built

Auth is implemented behind a small `AuthProvider` interface (`BasicAuthProvider` today), so other methods — OAuth, cookie/nonce auth, etc. — can be added later without touching request-building code.
