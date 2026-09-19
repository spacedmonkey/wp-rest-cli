# Uploading files

Any `create` (or `update`) can upload a file. The flag is **the parameter name the endpoint itself expects** — the CLI has no fixed `--file` flag. Core's media endpoint reads a parameter called `file`, so that is what you use there; a custom route that reads `attachment` takes `--attachment=...`.

Mark a value as a file with a leading `@`:

```sh
--<parameter>=@<path-or-url>
```

## Quick start

```sh
wp wp/v2 media create --file=./cat.jpg --title="Cat" --alt_text="A cat" --url=https://example.com
```

Uploading needs the `upload_files` capability — use an [Application Password](authentication.md). Output follows the usual `--format` rules (`Success: Created media 123`, `--format=ids`, `--format=json`).

On `wp/v2/media` (and `media/<id>/sideload`) the `@` is optional, because the CLI knows core's field. Everywhere else it is required, unless the route's schema declares the argument as `format: binary`, in which case a bare path works too.

## Other endpoints

```sh
wp my-plugin/v1 documents create --attachment=@./report.pdf --title="Q3"
```

- The name after `--` is whatever that route's arguments call it. Run `wp <namespace> <route>` to see them.
- To send a literal string starting with `@`, double it: `--title=@@home` sends `@home`.
- Any value starting with `@` on `create`/`update` is treated as a file, on every route — so `--content=@johndoe` would try to read a file. Use `@@johndoe` for a literal `@johndoe`, especially when passing untrusted text from a script.
- File fields are only valid with `create` and `update` (`update` sends a POST, and takes one file). They can't be combined with `--body`.

## Multiple files

Repeat the parameter; each file becomes its own request:

```sh
wp wp/v2 media create --file=./a.jpg --file=./b.png --title="Gallery" --format=ids
```

Results are reported per file. If some fail, the successes are still printed, failures go to stderr as `path: message`, a `Warning: 1 of 2 failed` line is shown, and the exit code is `1`. `--quiet` hides progress, not errors. The CLI does no globbing itself; use your shell:

```sh
for f in *.jpg; do wp wp/v2 media create --file="$f"; done
```

## Importing from a URL

```sh
wp wp/v2 media create --file=@https://example.com/cat.jpg
```

The CLI downloads the file to a temporary directory, then uploads it like a local file, so any file type works. Paths and URLs can be mixed in one command.

- Only `http`/`https`; redirects are followed, but one that ends on plain `http` after an `https` URL is rejected.
- Your WordPress credentials are **never** sent to the source host.
- Filename: `Content-Disposition`, else the last URL path segment (query string dropped), else `download`; a missing extension is derived from `Content-Type`.
- Download failures are reported per file (`Unable to download '<url>'. Reason: HTTP 404 Not Found.`) and the rest continue.

On WordPress 7.1+ you can instead pass core's own `url=https://...` field and let the server fetch it (images only, public hosts only). That is a server feature; the CLI just sends it as an ordinary field.

## Media fields

`title` (defaults to the filename), `alt_text`, `caption`, `description`, `post` (attach to a post id), `status`. WordPress generates image sizes on the server.

## Errors and limits

The CLI applies no size limit of its own — files are streamed, not loaded into memory, up to the largest size Node can represent exactly. Server limits can't be discovered remotely, so they surface as errors:

| Symptom | Fix |
| --- | --- |
| HTTP 413, or `rest_upload_no_data` on a large file | Raise `upload_max_filesize`, `post_max_size`, the web server's `client_max_body_size`, or your CDN's limit. |
| `rest_upload_*` type errors | The type isn't allowed for your user (`upload_mimes`; `unfiltered_upload` bypasses this). |
| `rest_cannot_create` | The user lacks `upload_files`. |
| 5xx while generating sizes | Scale the image down. The CLI deletes the orphaned attachment. |

`--timeout=<ms>` (default 300000) is an idle timeout for uploads and a total time limit for URL downloads; raise it for large or slow transfers. A warning is printed when uploading over plain `http://` to a non-local host.

## Not supported yet

stdin (`@-`), glob expansion, replacing an existing media file's contents, byte-level upload progress, client-side image processing.
