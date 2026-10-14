# Agent apply workflows — soft-skip only

Incomplete chunk / large-sources jobs MUST `sys.exit(0)` (green wait), never fail on missing parts.

- Use `apply-payload.yml` (dispatch-only, soft-skip).
- Do **not** push `on.push` apply ymls that `exit 1` / assert on missing files.
- If you must keep `on.push`, soft-skip: missing chunk → exit 0; decode errors → exit 0.
- Do not merge one-shot apply workflows into `main`.
