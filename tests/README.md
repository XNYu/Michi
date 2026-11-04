# Standalone checks

- `install.test.mjs` checks the public installer contract without installing Michi.
- `integration/isolation.sh` is an opt-in, two-account hosted-isolation check;
  read its setup instructions before running it.

Automated runtime and subagent regressions live in `../backend/test/` and
`../runtime/test/`. The isolated browser suite lives in `../e2e/`. Real-runtime
acceptance is documented in `../scripts/verification/README-reuse-consistency-live.md`.
