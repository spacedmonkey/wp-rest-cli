# Configuration

Save `--url`/`--username` defaults on disk so you don't have to repeat them on every invocation:

```sh
wp-rest-cli config set --url=https://example.com --username=admin
wp-rest-cli config get
wp-rest-cli config clear
```

Once saved, `--url`/`--username` become optional on every other command — pass them explicitly to override the saved default for a single invocation.

!!! note "Passwords are never saved"
    Only `--url` and `--username` are persisted. Passwords must always come from `--password` or the `WP_PASSWORD` environment variable — see [Authentication](authentication.md).
