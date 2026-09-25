---
tags:
  - config
  - cli
---

# Configuration

Save `--url`/`--username` defaults on disk so you don't have to repeat them on every invocation:

```sh
wrapido config set --url=https://example.com --username=admin
wrapido config get
wrapido config clear
```

Once saved, `--url`/`--username` become optional on every other command — pass them explicitly to override the saved default for a single invocation.

!!! note "Credentials live under `wrapido auth`, not `wrapido config`"
`wrapido config` only ever stores the default `--url`/`--username` shown above — it never stores a password. To store a full username/password (or Application Password) per site, and have it used automatically, see [`wrapido auth`](authentication.md#stored-credentials-wrapido-auth). `wrapido config clear` only clears the default `--url`/`--username`; it does not remove any credentials saved via `wrapido auth` — use `wrapido auth application-passwords remove <url>` (or `wrapido auth application-passwords remove --all`) for that.

## YAML config files

Every global flag that makes sense as a default can be set in a YAML file, the same way [WP-CLI's `config.yml`](https://make.wordpress.org/cli/handbook/references/config/) works. Keys are the flag names. A full example with every supported key:

```yaml
# wrapido.yml
url: https://example.com # --url
context: view # --context: view | edit | embed
format: table # --format: table | json | csv | yaml | ids | count | raw
timeout: 30000 # --timeout, in milliseconds
use-auth: application-passwords # --use-auth: env | none | application-passwords | oauth2
color: true # false is the same as --no-color
pager: true # false is the same as --no-pager
quiet: false # --quiet
debug: false # --debug
```

Every key is optional; omit the ones you don't need.

### Global flags

| Flag                                        | YAML key       | Env var                                                                                          | In a config file?                  |
| ------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------- |
| `--url`                                     | `url`          | —                                                                                                | yes                                |
| `--context`                                 | `context`      | —                                                                                                | yes                                |
| `--format`                                  | `format`       | —                                                                                                | yes                                |
| `--timeout`                                 | `timeout`      | —                                                                                                | yes                                |
| `--use-auth`                                | `use-auth`     | —                                                                                                | yes                                |
| `--no-color`                                | `color: false` | —                                                                                                | yes                                |
| `--no-pager`                                | `pager: false` | `WRAPIDO_PAGER`, `PAGER` (which pager to run, not whether — see [Paging output](#paging-output)) | yes                                |
| `--quiet`                                   | `quiet`        | —                                                                                                | yes                                |
| `--debug`                                   | `debug`        | —                                                                                                | yes                                |
| `--username`                                | —              | `WP_USERNAME`                                                                                    | no — needs a password to be useful |
| `--password`                                | —              | `WP_PASSWORD`                                                                                    | no — secret                        |
| `--client-id`, `--client-secret`, `--token` | —              | —                                                                                                | no — secrets / one-off credentials |
| `--fields`, `--field`, `--body`             | —              | —                                                                                                | no — per-invocation                |
| `--truncate-length`                         | —              | —                                                                                                | no — per-invocation                |
| `-h`, `--help`                              | —              | —                                                                                                | no                                 |

Putting a "no" key in a file is an error, so a secret can't be committed by accident. Use `WP_USERNAME`/`WP_PASSWORD` or [`wrapido auth`](authentication.md#stored-credentials-wrapido-auth) for credentials.

### Which file is used

Files are read from, highest precedence first:

| #   | File                    | Where it is looked for                                    | Typical use                                |
| --- | ----------------------- | --------------------------------------------------------- | ------------------------------------------ |
| 1   | `wrapido.local.yml`     | current directory, then each parent (nearest wins)        | personal overrides; add it to `.gitignore` |
| 2   | `wrapido.yml`           | current directory, then each parent (nearest wins)        | per-project defaults; commit it            |
| 3   | `~/.wrapido/config.yml` | your home directory, or the path in `WRAPIDO_CONFIG_PATH` | your defaults everywhere                   |

The files are layered per key: a key missing from `wrapido.local.yml` falls through to `wrapido.yml`, then to the user-level file. Search starts from the directory you run the command in — never from where the package is installed — so a global install and a project-local one (`npx`, npm scripts) behave the same. A global install leans on the user-level file, since it is usually run from arbitrary directories.

### Precedence

1. Command-line flag (e.g. `--format=json`)
2. `WP_USERNAME`/`WP_PASSWORD` (credentials only)
3. `wrapido.local.yml`
4. `wrapido.yml`
5. `~/.wrapido/config.yml`
6. Defaults saved with `wrapido config set` (`url` only takes effect here, below the files)
7. Built-in defaults

Example — the same `format` from three places:

```sh
# ~/.wrapido/config.yml has `format: csv`; ./wrapido.yml has `format: yaml`
wrapido wp/v2 posts list            # yaml  (project file beats user file)
wrapido wp/v2 posts list --format=json   # json  (flag beats every file)
```

`wrapido config get` shows every value and the file it came from; `--debug` lists the files loaded. Unknown keys and wrong value types are errors that name the file.

!!! warning "Project files are trusted input"
A `wrapido.yml` in a repository you cloned can set `url`. If `WP_USERNAME`/`WP_PASSWORD` are exported, they would be sent to that site. Check unfamiliar projects (`wrapido config get`) before running commands in them. This is unrelated to WP-CLI's own `wrapido config`, which edits `wp-config.php`.

## Paging output

Any command's output — `list`/`get`/`create`/... results, route/namespace listings, `auth ... list`, and `help`/`--help` text alike — pages through `less` (or `$PAGER`) when run at a real interactive terminal, the same way `git log` or the AWS CLI does.

Paging only ever engages when stdout is a live terminal — it is automatically off for piped/redirected output, scripts, CI, and [agent mode](agent-mode.md), regardless of any of the settings below.

-   **`--no-pager`** (or `pager: false` in a config file) turns it off unconditionally.
-   **`WRAPIDO_PAGER`**, then **`PAGER`**, choose which pager command to run; an empty value (`PAGER=`) also disables paging. With neither set, the default is `less -FR` (`-F` quit if it fits one screen, `-R` pass through color) on Linux/macOS — there is no built-in default on Windows, where `less` isn't reliably present. Quitting the pager clears its content from view, like a normal `less`/`git log` session — this is what lets your terminal's mouse-wheel/trackpad scrolling work while it's open (a `-X` flag that kept content on screen after quitting was tried first, but that also silently disabled scroll-wheel support in most terminals).
-   Output that already fits on one screen is printed directly, without invoking a pager at all — measured against the terminal's actual reported size (not left to a pager's own "quit if it fits" flag, which isn't reliably honored by every terminal/multiplexer).

Mouse-wheel/trackpad scrolling while the pager is open depends on your terminal app translating that gesture into input `less` understands — this is outside `wrapido`'s control. **iTerm2** needs an explicit preference for it: Preferences → Profiles → your profile → Terminal → "Scroll wheel sends arrow keys when in alternate screen mode" (or Preferences → Advanced → Mouse, depending on version). **Terminal.app** has no equivalent setting and may not forward scroll events to `less` at all; the arrow keys, `Space`/`b`, and `/` (search) always work regardless.

```sh
wrapido wp/v2 posts list --url=https://example.com                 # pages through less at a terminal
wrapido wp/v2 posts list --url=https://example.com --no-pager       # never pages
WRAPIDO_PAGER=cat wrapido help wp/v2 posts                          # pages through `cat` (effectively unpaged, but still shows the full command)
```

## Rotating the local encryption key

Stored `wrapido auth` credentials are encrypted on disk under a random key generated once per machine (see [Authentication](authentication.md#stored-credentials-wrapido-auth) for how). If that key file is ever suspected compromised — or you just want to invalidate a stray backup copy of the config file — rotate it:

```sh
wrapido config rotate-key
```

This regenerates the local key and re-encrypts the existing store under it; every previously-saved default and `wrapido auth` credential is preserved and still reads back the same afterwards. It does **not** by itself revoke anything on any WordPress site — it only changes what protects the local file. Pair it with `wrapido auth application-passwords remove --all` when the concern is "my stored credentials might be compromised," not just local-key hygiene.
