# Contributing to claudedeck

Thanks for your interest. claudedeck is a small, focused codebase — most contributions land quickly.

## Development setup

Requirements: Node.js >= 18.17 (we test on 20 and 22) and npm.

```bash
git clone https://github.com/JaydenCJ/claudedeck
cd claudedeck
npm install
npm run build      # tsc → dist/
npm test           # vitest, must be green
npm run demo       # run `stats` against the bundled fixtures
```

To iterate on the dashboard against fixture data:

```bash
npm run build && node dist/cli.js serve --dir tests/fixtures/claude-home
```

## Project layout

| Path | What lives there |
|---|---|
| `src/parser/` | JSONL session-log parsing (usage, models, sidechains, MCP tools) |
| `src/pricing/` | Model pricing table + cost math |
| `src/engine/` | Aggregation across project / date / model / subagent / MCP server |
| `src/config/` | `~/.claude` inspection (skills, hooks, agents, commands, MCP servers) |
| `src/sync/` | Snapshot export/import with secret redaction |
| `src/server/` | Local dashboard (node:http + one inline HTML page) |
| `src/cli.ts` | Commander-based CLI |
| `tests/` | Vitest suites + `tests/fixtures/claude-home` (a fake `~/.claude`) |

## Tests

- Every behavior change needs a test. Fixture-driven tests live in `tests/`; extend
  `tests/fixtures/claude-home` rather than mocking the filesystem.
- Run `npm test` before pushing; CI runs the same commands (`npm ci && npm run build && npm test && bash scripts/smoke.sh`).
- Cost math must be asserted with exact expected values (see `tests/aggregate.test.ts` for the pattern).

## Commit conventions

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(engine): attribute cache-read tokens per MCP server
fix(parser): tolerate truncated JSONL lines
docs: sync zh/ja READMEs
test(snapshot): cover Authorization header redaction
```

Keep PRs focused on one change; update all three READMEs (`README.md`, `README.zh.md`, `README.ja.md`) when user-facing behavior changes.

## Hard rules

- **Zero upload stays zero upload.** No network calls, no telemetry, no CDN assets — the dashboard must remain fully self-contained.
- **Never weaken secret redaction.** New snapshot fields default to redacted; opt-outs must be explicit.
- No heavyweight dependencies: the runtime dependency budget is essentially `commander`.

## Code of conduct

Be kind and assume good intent; harassment or personal attacks of any kind are not tolerated.
