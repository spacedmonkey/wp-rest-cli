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

## YAML config files

Every global flag that makes sense as a default can be set in a YAML file, the same way [WP-CLI's `config.yml`](https://make.wordpress.org/cli/handbook/references/config/) works. Keys are the flag names. A full example with every supported key:

```yaml
# wp-rest-cli.yml
url: https://example.com   # --url
context: view              # --context: view | edit | embed
format: table              # --format: table | json | csv | yaml | ids | count | raw
timeout: 30000             # --timeout, in milliseconds
use-auth: application-passwords  # --use-auth: env | none | application-passwords | oauth2
color: true                # false is the same as --no-color
quiet: false               # --quiet
debug: false               # --debug
```

Every key is optional; omit the ones you don't need.

### Global flags

| Flag | YAML key | Env var | In a config file? |
| --- | --- | --- | --- |
| `--url` | `url` | — | yes |
| `--context` | `context` | — | yes |
| `--format` | `format` | — | yes |
| `--timeout` | `timeout` | — | yes |
| `--use-auth` | `use-auth` | — | yes |
| `--no-color` | `color: false` | — | yes |
| `--quiet` | `quiet` | — | yes |
| `--debug` | `debug` | — | yes |
| `--username` | — | `WP_USERNAME` | no — needs a password to be useful |
| `--password` | — | `WP_PASSWORD` | no — secret |
| `--client-id`, `--client-secret`, `--token` | — | — | no — secrets / one-off credentials |
| `--fields`, `--field`, `--body` | — | — | no — per-invocation |
| `-h`, `--help` | — | — | no |

Putting a "no" key in a file is an error, so a secret can't be committed by accident. Use `WP_USERNAME`/`WP_PASSWORD` or [`wp auth`](authentication.md#stored-credentials-wp-auth) for credentials.

### Which file is used

Files are read from, highest precedence first:

| # | File | Where it is looked for | Typical use |
| --- | --- | --- | --- |
| 1 | `wp-rest-cli.local.yml` | current directory, then each parent (nearest wins) | personal overrides; add it to `.gitignore` |
| 2 | `wp-rest-cli.yml` | current directory, then each parent (nearest wins) | per-project defaults; commit it |
| 3 | `~/.wp-rest-cli/config.yml` | your home directory, or the path in `WP_REST_CLI_CONFIG_PATH` | your defaults everywhere |

The files are layered per key: a key missing from `wp-rest-cli.local.yml` falls through to `wp-rest-cli.yml`, then to the user-level file. Search starts from the directory you run the command in — never from where the package is installed — so a global install and a project-local one (`npx`, npm scripts) behave the same. A global install leans on the user-level file, since it is usually run from arbitrary directories.

### Precedence

1. Command-line flag (e.g. `--format=json`)
2. `WP_USERNAME`/`WP_PASSWORD` (credentials only)
3. `wp-rest-cli.local.yml`
4. `wp-rest-cli.yml`
5. `~/.wp-rest-cli/config.yml`
6. Defaults saved with `wp config set` (`url` only takes effect here, below the files)
7. Built-in defaults

Example — the same `format` from three places:

```sh
# ~/.wp-rest-cli/config.yml has `format: csv`; ./wp-rest-cli.yml has `format: yaml`
wp-rest-cli wp/v2 posts list                 # yaml  (project file beats user file)
wp-rest-cli wp/v2 posts list --format=json   # json  (flag beats every file)
```

`wp config get` shows every value and the file it came from; `--debug` lists the files loaded. Unknown keys and wrong value types are errors that name the file.

!!! warning "Project files are trusted input"
    A `wp-rest-cli.yml` in a repository you cloned can set `url`. If `WP_USERNAME`/`WP_PASSWORD` are exported, they would be sent to that site. Check unfamiliar projects (`wp config get`) before running commands in them. This is unrelated to WP-CLI's own `wp config`, which edits `wp-config.php`.

## Rotating the local encryption key

Stored `wp auth` credentials are encrypted on disk under a random key generated once per machine (see [Authentication](authentication.md#stored-credentials-wp-auth) for how). If that key file is ever suspected compromised — or you just want to invalidate a stray backup copy of the config file — rotate it:

```sh
wp-rest-cli config rotate-key
```

This regenerates the local key and re-encrypts the existing store under it; every previously-saved default and `wp auth` credential is preserved and still reads back the same afterwards. It does **not** by itself revoke anything on any WordPress site — it only changes what protects the local file. Pair it with `wp auth application-passwords remove --all` when the concern is "my stored credentials might be compromised," not just local-key hygiene.
