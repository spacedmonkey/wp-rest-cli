# Configuration

Save `--url`/`--username` defaults on disk so you don't have to repeat them on every invocation:

```sh
wp-rest-cli config set --url=https://example.com --username=admin
wp-rest-cli config get
wp-rest-cli config clear
```

Once saved, `--url`/`--username` become optional on every other command — pass them explicitly to override the saved default for a single invocation.

!!! note "Credentials live under `wp auth`, not `wp config`"
    `wp config` only ever stores the default `--url`/`--username` shown above — it never stores a password. To store a full username/password (or Application Password) per site, and have it used automatically, see [`wp auth`](authentication.md#stored-credentials-wp-auth). `wp config clear` only clears the default `--url`/`--username`; it does not remove any credentials saved via `wp auth` — use `wp auth application-passwords remove <url>` (or `wp auth application-passwords remove --all`) for that.

## Rotating the local encryption key

Stored `wp auth` credentials are encrypted on disk under a random key generated once per machine (see [Authentication](authentication.md#stored-credentials-wp-auth) for how). If that key file is ever suspected compromised — or you just want to invalidate a stray backup copy of the config file — rotate it:

```sh
wp-rest-cli config rotate-key
```

This regenerates the local key and re-encrypts the existing store under it; every previously-saved default and `wp auth` credential is preserved and still reads back the same afterwards. It does **not** by itself revoke anything on any WordPress site — it only changes what protects the local file. Pair it with `wp auth application-passwords remove --all` when the concern is "my stored credentials might be compromised," not just local-key hygiene.
