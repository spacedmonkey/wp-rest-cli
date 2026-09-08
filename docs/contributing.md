# Contributing

Contributions are welcome. The full contributor guide lives in the repository:

- [CONTRIBUTING.md](https://github.com/spacedmonkey/wp-rest-cli/blob/main/CONTRIBUTING.md) — local setup, running tests/lint/typecheck, PR conventions.
- [CODE_OF_CONDUCT.md](https://github.com/spacedmonkey/wp-rest-cli/blob/main/CODE_OF_CONDUCT.md)
- [SECURITY.md](https://github.com/spacedmonkey/wp-rest-cli/blob/main/SECURITY.md) — how to privately report a vulnerability.

## Quick summary

```sh
npm install
npm test          # jest (unit tests) + vitest (the execa-driven integration suite)
npm run lint
npm run typecheck
npm run format
```

Open a pull request against `main`. See the repository's [CLAUDE.md](https://github.com/spacedmonkey/wp-rest-cli/blob/main/CLAUDE.md) for a full architecture tour if you're changing how the CLI dispatches commands, discovers sites, or formats output.
