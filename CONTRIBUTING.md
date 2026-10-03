# Contributing

Thank you for improving PHP Tinker.

## Local setup

Use Node.js 22.12 or newer and install the locked dependency tree:

```sh
npm ci
```

Run the automated checks before submitting a change:

```sh
npm test
npm run build
npm audit
```

Start the development app with `npm run dev`. A PHP CLI is needed for PHP execution and the PHP-backed integration tests; tests that cannot find PHP report that condition explicitly.

## Pull requests

- Keep changes focused and preserve per-tab state isolation.
- Add a regression test before fixing a bug when practical.
- Do not add telemetry, license checks, hosted-service dependencies, or secrets.
- Do not expose Node APIs directly to the renderer. Add a narrowly scoped main-process handler and preload method when a capability must cross the IPC boundary.
- Treat selected projects as untrusted until the user presses **Run**. Indexing and previews must not evaluate project code.
- Update user documentation when settings, requirements, storage, or packaging behavior changes.

Security reports should follow [SECURITY.md](SECURITY.md), not a public issue.
