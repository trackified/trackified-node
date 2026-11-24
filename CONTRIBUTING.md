# Contributing

1. `npm install`
2. `npm test` (builds, then runs unit tests with a mocked fetch; no network)
3. `npm run lint && npm run typecheck`

Optional live smoke test (creates and deletes one tracking): `TRACKIFIED_API_KEY=tk_test_… node --test test/live.test.mjs`.
Never commit API keys. Open a pull request against `main`; keep changes small and add a test.
