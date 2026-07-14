#!/usr/bin/env bash
# claudedeck smoke test: builds the CLI, runs the core commands against the
# bundled fixture dataset, boots the dashboard on 127.0.0.1 and asserts the
# HTTP API (including the content-editor endpoints). Fully offline, idempotent
# (works on a throwaway copy of the fixtures), prints "SMOKE OK" on success.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORT="${CLAUDEDECK_SMOKE_PORT:-17433}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/claudedeck-smoke-XXXXXX")"
SERVER_PID=""

cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

fail() { echo "SMOKE FAIL: $1" >&2; exit 1; }

echo "[smoke] build"
npm run build --silent

# Work on a throwaway copy so the smoke test never mutates the fixtures.
cp -r tests/fixtures/claude-home "$WORK/home"

echo "[smoke] cli: stats --json"
node dist/cli.js stats --dir "$WORK/home" --json > "$WORK/stats.json"
node -e '
  const s = require(process.argv[1]);
  if (Math.abs(s.totals.costUsd - 0.1545) > 1e-9) throw new Error("unexpected total: " + s.totals.costUsd);
  if (s.totals.sessions !== 2) throw new Error("unexpected sessions: " + s.totals.sessions);
' "$WORK/stats.json" || fail "stats totals mismatch"

echo "[smoke] cli: top --by mcp"
node dist/cli.js top --by mcp --dir "$WORK/home" | grep -q "github" || fail "top --by mcp missing github row"

echo "[smoke] cli: --version matches package.json"
[ "$(node dist/cli.js --version)" = "$(node -p 'require("./package.json").version')" ] || fail "version drift"

echo "[smoke] cli: sync export redacts secrets"
node dist/cli.js sync export --dir "$WORK/home" -o "$WORK/snap.json" > /dev/null
grep -q "sk-ant-" "$WORK/snap.json" && fail "secret leaked into snapshot"

echo "[smoke] dashboard: boot on 127.0.0.1:$PORT"
node dist/cli.js serve --dir "$WORK/home" -p "$PORT" --host 127.0.0.1 > "$WORK/serve.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 50); do
  curl -sf "http://127.0.0.1:$PORT/api/summary" > /dev/null 2>&1 && break
  sleep 0.1
done

echo "[smoke] dashboard: GET / and /api/summary"
curl -sf "http://127.0.0.1:$PORT/" | grep -q "claudedeck" || fail "dashboard page missing"
curl -sf "http://127.0.0.1:$PORT/api/summary" | node -e '
  let d = ""; process.stdin.on("data", (c) => (d += c)).on("end", () => {
    const s = JSON.parse(d);
    if (Math.abs(s.costUsd - 0.1545) > 1e-9) { console.error("bad summary: " + d); process.exit(1); }
  });
' || fail "api/summary totals mismatch"

echo "[smoke] dashboard: content editor GET/PUT round-trip"
SKILL="$WORK/home/skills/changelog/SKILL.md"
curl -sf "http://127.0.0.1:$PORT/api/assets/content?filePath=$(node -p 'encodeURIComponent(process.argv[1])' "$SKILL")" \
  | grep -q "changelog" || fail "content GET missing skill body"
curl -sf -X PUT "http://127.0.0.1:$PORT/api/assets/content" \
  -H "content-type: application/json" \
  -d "{\"filePath\":$(node -p 'JSON.stringify(process.argv[1])' "$SKILL"),\"content\":\"# smoke-edited\\n\"}" \
  | grep -q '"ok":true' || fail "content PUT rejected"
grep -q "smoke-edited" "$SKILL" || fail "content PUT did not persist"

echo "[smoke] dashboard: write endpoints refuse escapes"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT/api/assets/content?filePath=/etc/passwd")
[ "$STATUS" = "400" ] || fail "path escape not rejected (got $STATUS)"

kill "$SERVER_PID"
wait "$SERVER_PID" 2>/dev/null || true
SERVER_PID=""

echo "SMOKE OK"
