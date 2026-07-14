/** Terminal output helpers: plain-text tables and number formatting. */

export function fmtUsd(v: number): string {
  if (v >= 100) return `$${v.toFixed(0)}`;
  if (v >= 0.01 || v === 0) return `$${v.toFixed(2)}`;
  return `$${v.toFixed(4)}`;
}

export function fmtTokens(v: number): string {
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return String(v);
}

/** Render rows as an aligned plain-text table. */
export function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) =>
    cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join("  ");
  const sep = widths.map((w) => "-".repeat(w)).join("  ");
  return [line(headers), sep, ...rows.map(line)].join("\n");
}

/** Simple unicode bar for terminal charts. */
export function bar(value: number, max: number, width = 24): string {
  if (max <= 0) return "";
  const filled = Math.max(value > 0 ? 1 : 0, Math.round((value / max) * width));
  return "█".repeat(filled).padEnd(width);
}
