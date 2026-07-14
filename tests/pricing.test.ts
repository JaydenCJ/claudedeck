import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  costOf,
  costOfTurn,
  DEFAULT_PRICING,
  loadPricingTable,
  resolvePricing,
  validatePricingTable,
} from "../src/pricing/pricing.js";

describe("resolvePricing", () => {
  it("matches exact model ids", () => {
    expect(resolvePricing("claude-opus-4-8")?.inputPerMTok).toBe(5);
    expect(resolvePricing("claude-haiku-4-5")?.outputPerMTok).toBe(5);
  });

  it("matches dated model ids by longest prefix", () => {
    // `claude-sonnet-4-5-20250929` must hit the sonnet tier, not error out.
    const p = resolvePricing("claude-sonnet-4-5-20250929");
    expect(p?.inputPerMTok).toBe(3);
    expect(p?.outputPerMTok).toBe(15);
  });

  it("prefers the more specific prefix", () => {
    // claude-opus-4-8 must resolve to the $5 tier, not the legacy claude-opus-4 $15 tier.
    expect(resolvePricing("claude-opus-4-8-20990101")?.inputPerMTok).toBe(5);
    // bare claude-opus-4-20250514 hits the legacy tier.
    expect(resolvePricing("claude-opus-4-20250514")?.inputPerMTok).toBe(15);
  });

  it("returns zero pricing for synthetic turns and undefined for unknown models", () => {
    expect(resolvePricing("<synthetic>")).toEqual({
      inputPerMTok: 0,
      outputPerMTok: 0,
      cacheWritePerMTok: 0,
      cacheReadPerMTok: 0,
    });
    expect(resolvePricing("gpt-oops")).toBeUndefined();
  });
});

describe("costOf / costOfTurn", () => {
  const usage = { inputTokens: 1000, outputTokens: 500, cacheCreationTokens: 2000, cacheReadTokens: 10000 };

  it("computes cost across all four token classes", () => {
    const pricing = DEFAULT_PRICING["claude-opus-4-8"];
    // 1000*5 + 500*25 + 2000*6.25 + 10000*0.5 = 35000 per MTok → $0.035
    expect(costOf(usage, pricing)).toBeCloseTo(0.035, 10);
  });

  it("reports unknown models through the callback and charges $0", () => {
    const unknown: string[] = [];
    const cost = costOfTurn("claude-experimental-99", usage, DEFAULT_PRICING, (m) => unknown.push(m));
    expect(cost).toBe(0);
    expect(unknown).toEqual(["claude-experimental-99"]);
  });

  it("returns 0 when model or usage is missing", () => {
    expect(costOfTurn(undefined, usage)).toBe(0);
    expect(costOfTurn("claude-opus-4-8", undefined)).toBe(0);
  });
});

describe("pricing overrides", () => {
  it("merges an override file over the defaults", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "claudedeck-pricing-"));
    const file = path.join(dir, "pricing.json");
    await fs.writeFile(
      file,
      JSON.stringify({
        "claude-experimental-99": { inputPerMTok: 2, outputPerMTok: 4, cacheWritePerMTok: 2.5, cacheReadPerMTok: 0.2 },
        "claude-opus-4-8": { inputPerMTok: 6, outputPerMTok: 30, cacheWritePerMTok: 7.5, cacheReadPerMTok: 0.6 },
      }),
    );
    const table = await loadPricingTable(file);
    expect(resolvePricing("claude-experimental-99", table)?.inputPerMTok).toBe(2);
    expect(resolvePricing("claude-opus-4-8", table)?.inputPerMTok).toBe(6); // overridden
    expect(resolvePricing("claude-haiku-4-5", table)?.inputPerMTok).toBe(1); // default kept
  });

  it("falls back to defaults when the override file is absent", async () => {
    const table = await loadPricingTable("/nonexistent/pricing.json");
    expect(table).toBe(DEFAULT_PRICING);
  });

  it("throws for an absent file when required (explicit --pricing)", async () => {
    await expect(loadPricingTable("/nonexistent/pricing.json", { required: true })).rejects.toThrow(
      /cannot read pricing file/,
    );
  });

  it("rejects malformed tables with a descriptive error", () => {
    expect(() => validatePricingTable([1, 2, 3])).toThrow(/JSON object/);
    expect(() => validatePricingTable({ "claude-x": { inputPerMTok: -1 } })).toThrow(/claude-x/);
    expect(() => validatePricingTable({ "claude-x": { inputPerMTok: 1, outputPerMTok: 2 } })).toThrow(
      /cacheWritePerMTok/,
    );
  });
});
