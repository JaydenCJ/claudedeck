import { beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAllEntries } from "../src/parser/jsonl.js";
import { aggregate, MAIN_CHAIN, NO_MCP, projectKey, totals } from "../src/engine/aggregate.js";
import type { LogEntry } from "../src/types.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "claude-home");

/**
 * Expected costs (see fixtures):
 *   a1 opus   0.035     s2 haiku 0.007    a2 opus 0.0225    a3 opus 0.03
 *   b2 sonnet 0.06      b3 unknown model  0
 * total = 0.1545
 */
let entries: LogEntry[];
beforeAll(async () => {
  entries = await loadAllEntries(FIXTURES);
});

describe("totals", () => {
  it("computes overall cost, tokens, sessions and projects", () => {
    const t = totals(entries);
    expect(t.costUsd).toBeCloseTo(0.1545, 10);
    expect(t.turns).toBe(6);
    expect(t.sessions).toBe(2);
    expect(t.projects).toBe(2);
    expect(t.inputTokens).toBe(1000 + 2000 + 3000 + 1000 + 10000 + 500);
    expect(t.outputTokens).toBe(500 + 1000 + 200 + 1000 + 2000 + 100);
    expect(t.cacheCreationTokens).toBe(2000);
    expect(t.cacheReadTokens).toBe(15000);
    expect(t.firstTimestamp?.toISOString()).toBe("2026-07-01T10:00:00.000Z");
    expect(t.lastTimestamp?.toISOString()).toBe("2026-07-02T09:01:00.000Z");
  });

  it("honors reportedCostUsd over computed cost when present", () => {
    const cloned = structuredClone(entries) as LogEntry[];
    for (const e of cloned) e.timestamp = new Date(e.timestamp); // structuredClone keeps Dates, but be explicit
    const b2 = cloned.find((e) => e.uuid === "b2")!;
    b2.reportedCostUsd = 1.23;
    expect(totals(cloned).costUsd).toBeCloseTo(0.1545 - 0.06 + 1.23, 10);
  });

  it("applies since/until filters", () => {
    const t = totals(entries, { since: new Date("2026-07-02T00:00:00Z") });
    expect(t.costUsd).toBeCloseTo(0.06, 10);
    const t2 = totals(entries, { until: new Date("2026-07-01T23:59:59Z") });
    expect(t2.costUsd).toBeCloseTo(0.0945, 10);
  });

  it("surfaces unknown models via the callback", () => {
    const unknown = new Set<string>();
    totals(entries, { onUnknownModel: (m) => unknown.add(m) });
    expect(unknown).toEqual(new Set(["claude-experimental-99"]));
  });
});

describe("aggregate by project", () => {
  it("groups cost by normalized project key, sorted by cost", () => {
    const rows = aggregate(entries, "project");
    expect(rows.map((r) => r.key)).toEqual(["dev/webapp", "dev/api"]);
    expect(rows[0].costUsd).toBeCloseTo(0.0945, 10);
    expect(rows[1].costUsd).toBeCloseTo(0.06, 10);
  });
});

describe("aggregate by date", () => {
  it("groups per UTC day in chronological order", () => {
    const rows = aggregate(entries, "date");
    expect(rows.map((r) => r.key)).toEqual(["2026-07-01", "2026-07-02"]);
    expect(rows[0].costUsd).toBeCloseTo(0.0945, 10);
    expect(rows[1].costUsd).toBeCloseTo(0.06, 10);
  });
});

describe("aggregate by model", () => {
  it("splits cost per model id", () => {
    const rows = aggregate(entries, "model");
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(byKey["claude-opus-4-8"].costUsd).toBeCloseTo(0.0875, 10);
    expect(byKey["claude-opus-4-8"].turns).toBe(3);
    expect(byKey["claude-haiku-4-5"].costUsd).toBeCloseTo(0.007, 10);
    expect(byKey["claude-sonnet-4-5-20250929"].costUsd).toBeCloseTo(0.06, 10);
    expect(byKey["claude-experimental-99"].costUsd).toBe(0);
  });
});

describe("aggregate by subagent", () => {
  it("attributes sidechain turns to their subagent and the rest to (main)", () => {
    const rows = aggregate(entries, "subagent");
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(byKey["code-reviewer"].costUsd).toBeCloseTo(0.007, 10);
    expect(byKey["code-reviewer"].turns).toBe(1);
    expect(byKey[MAIN_CHAIN].costUsd).toBeCloseTo(0.1545 - 0.007, 10);
    expect(byKey[MAIN_CHAIN].turns).toBe(5);
  });
});

describe("aggregate by MCP server", () => {
  it("attributes turn cost to invoked servers, split evenly across servers in a turn", () => {
    const rows = aggregate(entries, "mcp");
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
    // a2: full 0.0225 to github (2 calls); a3: 0.03 split github/slack.
    expect(byKey["github"].costUsd).toBeCloseTo(0.0225 + 0.015, 10);
    expect(byKey["github"].toolCalls).toBe(3);
    expect(byKey["slack"].costUsd).toBeCloseTo(0.015, 10);
    expect(byKey["slack"].toolCalls).toBe(1);
    expect(byKey[NO_MCP].costUsd).toBeCloseTo(0.1545 - 0.0225 - 0.03, 10);
  });

  it("conserves total cost across MCP buckets", () => {
    const rows = aggregate(entries, "mcp");
    const sum = rows.reduce((acc, r) => acc + r.costUsd, 0);
    expect(sum).toBeCloseTo(totals(entries).costUsd, 10);
  });
});

describe("projectKey", () => {
  it("shortens long paths to the last two segments", () => {
    expect(projectKey("/home/dev/webapp")).toBe("dev/webapp");
    expect(projectKey("webapp")).toBe("webapp");
  });
});
