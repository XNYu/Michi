# Runtime Harness Tests

This directory contains standalone harnesses for inspecting runtime and
subagent event behavior against a running Michi backend. They complement the
unit suites in `frontend/` and `backend/test/` and the browser workflows in
`e2e/`.

The harness scripts use port `52249` by default. Override it with `PORT`, and
provide `MICHI_TEST_WORKSPACE_ID` or `MICHI_TEST_CWD` when an isolated target is
needed.
