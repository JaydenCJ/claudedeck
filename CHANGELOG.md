# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-07-08

### Added

- **JSONL session-log parser** for `~/.claude/projects/**/*.jsonl`: messages, usage
  tokens (input / output / cache write / cache read), model ids, timestamps,
  sidechain markers, and MCP tool calls. Tolerant of malformed lines; data
  directory configurable via `--dir` / `CLAUDE_CONFIG_DIR`.
- **Duplicate-turn deduplication**: assistant lines sharing the same
  `message.id` + `requestId` (streamed multi-block turns, and turns replayed
  into continued-session files) are billed exactly once — tool_use blocks from
  continuation lines are still merged in for MCP/subagent attribution, but
  usage and turn counts never double.
- **Subagent resolution**: sidechain entries are linked back to the `Task` tool
  call that spawned them (prompt matching over the parentUuid chain), enabling
  real per-subagent cost accounting.
- **Cost attribution engine** aggregating cost and token usage across five
  dimensions: project, date, model, subagent, and MCP server. Per-MCP-server
  attribution splits a turn's cost evenly among the servers it invokes and
  conserves the overall total.
- **Built-in pricing table** for the Claude model family (per-MTok input /
  output / cache write / cache read), with longest-prefix model matching,
  user overrides via `claudedeck.pricing.json` or `--pricing`, and a
  `claudedeck pricing` command to print the effective table.
- **Config inspector**: structured listing of agents, slash commands, skills,
  hooks (with event / matcher / command / source / enabled state), and MCP
  servers collected from every place Claude Code reads them: `settings.json`,
  `settings.local.json`, the `~/.claude.json` sibling file (top-level and
  per-project `projects.*.mcpServers`), and the project-local `.mcp.json` —
  each entry labeled with its source.
- **Skills & hooks editor** (CLI + dashboard): `claudedeck skills
  enable|disable <name>` toggles skills/agents/commands non-destructively via
  a `.disabled` file suffix, `claudedeck skills new <kind> <name>` scaffolds
  new assets from templates, and `claudedeck hooks enable|disable <n>` moves
  hooks between the settings `hooks` and a claudedeck-managed `disabledHooks`
  section (definition preserved verbatim). The dashboard exposes the same
  operations through Enable/Disable buttons and a create form backed by
  `POST /api/assets/toggle`, `/api/assets/new`, and `/api/hooks/toggle`,
  plus **in-dashboard content editing** of skill/agent/command markdown files
  via `GET`/`PUT /api/assets/content` and an inline editor panel (writes are
  confined to the Claude config directory, only markdown assets are editable,
  and `PUT` never creates new files). Toggles report no-ops honestly: the CLI
  prints "already enabled/disabled — nothing to do" and the API returns
  `changed: false` instead of a misleading success message.
- **Dashboard hardening**: the server only answers requests whose Host header
  names this machine (DNS-rebinding guard), write requests (POST/PUT) must
  carry no Origin header or a local one (CSRF guard), bodies must be
  `application/json` (blocks preflight-free `text/plain` posts) and are capped
  at 64 KiB.
- **Config snapshots**: `claudedeck sync export` packs `settings.json`, agents,
  commands, skills and `CLAUDE.md` into one portable JSON with secrets
  (API keys, tokens, `Authorization` headers, `sk-ant-…` strings) stripped by
  default and every redaction listed; `claudedeck sync import` applies a
  snapshot with overwrite protection (`--force`) and path-traversal rejection.
  `settings.local.json` is machine-local and intentionally excluded from
  snapshots.
- **CLI** (`claudedeck`) with subcommands `stats`, `top --by
  project|date|model|subagent|mcp`, `skills [list|enable|disable|new]`,
  `hooks [list|enable|disable]`, `sync export|import`, `pricing`, and `serve`;
  `--json` output and `--since` / `--until` filters (a bare `--until` date is
  inclusive of that whole day). A nonexistent data directory and an explicit
  `--pricing` file that cannot be read are reported instead of silently
  producing $0.00 reports.
- **Local web dashboard** (`claudedeck serve`): node:http server bound to
  `127.0.0.1` serving a single self-contained HTML page (inline CSS/JS, SVG
  charts, zero external assets, zero telemetry) with summary cards, daily
  spend chart, per-dimension cost breakdowns, skills/hooks/MCP panels, and
  the edit controls described above.
- **Single-binary releases** (planned): a release workflow will build self-contained
  `claudedeck` binaries for linux-x64/arm64, darwin-x64/arm64 and windows-x64
  with `bun build --compile` on every version tag and attach them (plus
  SHA256 checksums) to the GitHub Release — no Node.js required. npm remains
  the other supported install path.
- **Fixture dataset** (`tests/fixtures/claude-home`, `.claude.json`,
  `project/.mcp.json`) — a fake `~/.claude` with two projects, a subagent
  sidechain, MCP tool calls, hooks and skills — plus 97 unit/integration
  tests covering parsing, deduplication, pricing, aggregation, config
  inspection and editing, snapshot redaction, and the dashboard API
  (including the write/content endpoints and the Host/Origin guards), and a
  `scripts/smoke.sh` end-to-end smoke script (CLI + dashboard over HTTP) run
  after the unit tests (CI will run it as part of the release workflow). The CLI reads its version from
  `package.json` so `--version` can never drift from the published package.

[Unreleased]: https://github.com/JaydenCJ/claudedeck/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/JaydenCJ/claudedeck/releases/tag/v0.1.0
