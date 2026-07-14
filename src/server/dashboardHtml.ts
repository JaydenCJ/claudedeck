/**
 * The claudedeck dashboard: a single self-contained HTML page.
 *
 * No external assets, no CDNs, no analytics — everything (CSS, JS, charts)
 * is inlined so the dashboard works fully offline and never phones home.
 * Charts are rendered with plain DOM bars and a small hand-rolled SVG line
 * chart; no frontend framework required.
 */

export const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>claudedeck</title>
<style>
:root {
  --bg: #0f1115; --panel: #171a21; --border: #262b36;
  --text: #e6e9ef; --muted: #8b93a3; --accent: #d97757;
  --accent2: #6a9bcc; --good: #7dc383;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: var(--bg); color: var(--text); font: 14px/1.5 ui-sans-serif, system-ui, sans-serif; padding: 24px; }
header { display: flex; align-items: baseline; gap: 12px; margin-bottom: 20px; flex-wrap: wrap; }
header h1 { font-size: 20px; letter-spacing: 0.5px; }
header h1 .deck { color: var(--accent); }
header .sub { color: var(--muted); font-size: 13px; }
.controls { margin-left: auto; display: flex; gap: 8px; align-items: center; color: var(--muted); font-size: 13px; }
select { background: var(--panel); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 4px 8px; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 20px; }
.card { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; }
.card .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.8px; }
.card .value { font-size: 24px; font-weight: 600; margin-top: 4px; font-variant-numeric: tabular-nums; }
.card .detail { color: var(--muted); font-size: 12px; margin-top: 2px; }
.panel { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 16px; margin-bottom: 16px; }
.panel h2 { font-size: 14px; margin-bottom: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.8px; }
.two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
@media (max-width: 900px) { .two-col { grid-template-columns: 1fr; } }
.bar-row { display: grid; grid-template-columns: minmax(120px, 220px) 1fr 90px; gap: 10px; align-items: center; padding: 4px 0; }
.bar-row .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bar-track { background: #0c0e12; border-radius: 4px; height: 18px; overflow: hidden; }
.bar-fill { height: 100%; border-radius: 4px; background: var(--accent); min-width: 2px; }
.bar-fill.alt { background: var(--accent2); }
.bar-row .amount { text-align: right; font-variant-numeric: tabular-nums; color: var(--muted); }
.empty { color: var(--muted); font-style: italic; padding: 8px 0; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--border); }
th { color: var(--muted); font-weight: 500; }
td.num { text-align: right; font-variant-numeric: tabular-nums; }
.pill { display: inline-block; background: #232836; border-radius: 999px; padding: 1px 8px; font-size: 12px; color: var(--muted); margin-right: 4px; }
.pill.off { color: var(--accent); }
button.btn { background: #232836; color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 2px 10px; font-size: 12px; cursor: pointer; }
button.btn:hover { border-color: var(--accent); }
.new-asset { display: flex; gap: 8px; margin-top: 12px; align-items: center; flex-wrap: wrap; }
.new-asset input { background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 4px 8px; font-size: 13px; }
#editor-panel { display: none; }
#editor-panel.open { display: block; }
#editor-file { color: var(--muted); font-size: 12px; word-break: break-all; margin-bottom: 8px; }
#editor-text { width: 100%; min-height: 260px; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 8px; padding: 10px; font: 13px/1.5 ui-monospace, monospace; resize: vertical; }
.editor-actions { display: flex; gap: 8px; margin-top: 8px; align-items: center; }
.flash { font-size: 12px; color: var(--good); margin-top: 6px; min-height: 16px; }
.flash.err { color: var(--accent); }
svg text { fill: var(--muted); font-size: 10px; }
footer { color: var(--muted); font-size: 12px; margin-top: 24px; }
code { background: #232836; padding: 1px 5px; border-radius: 4px; font-size: 12px; }
</style>
</head>
<body>
<header>
  <h1>claude<span class="deck">deck</span></h1>
  <span class="sub">local-first Claude Code control deck &mdash; nothing leaves this machine</span>
  <div class="controls">
    <label for="range">Range</label>
    <select id="range">
      <option value="7">Last 7 days</option>
      <option value="30" selected>Last 30 days</option>
      <option value="90">Last 90 days</option>
      <option value="0">All time</option>
    </select>
  </div>
</header>

<div class="grid" id="summary-cards"></div>

<div class="panel">
  <h2>Daily spend</h2>
  <div id="daily-chart"></div>
</div>

<div class="two-col">
  <div class="panel"><h2>Cost by project</h2><div id="by-project"></div></div>
  <div class="panel"><h2>Cost by model</h2><div id="by-model"></div></div>
  <div class="panel"><h2>Cost by MCP server</h2><div id="by-mcp"></div></div>
  <div class="panel"><h2>Cost by subagent</h2><div id="by-subagent"></div></div>
</div>

<div class="two-col">
  <div class="panel">
    <h2>Skills, agents &amp; commands</h2>
    <div id="assets"></div>
    <div class="new-asset">
      <select id="new-kind"><option value="skill">skill</option><option value="agent">agent</option><option value="command">command</option></select>
      <input id="new-name" placeholder="name (e.g. release-notes)" size="22">
      <button class="btn" id="new-create">Create</button>
    </div>
    <div class="flash" id="assets-flash"></div>
  </div>
  <div class="panel">
    <h2>Hooks &amp; MCP servers</h2>
    <div id="hooks"></div>
    <div class="flash" id="hooks-flash"></div>
  </div>
</div>

<div class="panel" id="editor-panel">
  <h2>Edit asset</h2>
  <div id="editor-file"></div>
  <textarea id="editor-text" spellcheck="false"></textarea>
  <div class="editor-actions">
    <button class="btn" id="editor-save">Save</button>
    <button class="btn" id="editor-cancel">Cancel</button>
    <span class="flash" id="editor-flash"></span>
  </div>
</div>

<footer>claudedeck &mdash; zero upload, MIT licensed. Data source: <code id="data-dir"></code></footer>

<script>
"use strict";
const fmtUsd = (v) => "$" + v.toFixed(v >= 100 ? 0 : 2);
const fmtTok = (v) => v >= 1e9 ? (v / 1e9).toFixed(1) + "B" : v >= 1e6 ? (v / 1e6).toFixed(1) + "M" : v >= 1e3 ? (v / 1e3).toFixed(1) + "k" : String(v);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(url + " -> " + res.status);
  return res.json();
}

function card(label, value, detail) {
  return '<div class="card"><div class="label">' + esc(label) + '</div><div class="value">' + esc(value) + '</div>' +
    (detail ? '<div class="detail">' + esc(detail) + '</div>' : '') + '</div>';
}

function barList(el, rows, opts) {
  opts = opts || {};
  if (!rows.length) { el.innerHTML = '<div class="empty">No data in this range.</div>'; return; }
  const max = Math.max(...rows.map((r) => r.costUsd), 1e-9);
  el.innerHTML = rows.slice(0, 12).map((r, i) =>
    '<div class="bar-row"><span class="name" title="' + esc(r.key) + '">' + esc(r.key) + '</span>' +
    '<div class="bar-track"><div class="bar-fill' + (opts.alt ? ' alt' : '') + '" style="width:' + Math.max(1, (r.costUsd / max) * 100) + '%"></div></div>' +
    '<span class="amount">' + fmtUsd(r.costUsd) + (r.toolCalls != null ? ' &middot; ' + r.toolCalls + ' calls' : '') + '</span></div>'
  ).join("");
}

function lineChart(el, rows) {
  if (!rows.length) { el.innerHTML = '<div class="empty">No data in this range.</div>'; return; }
  const W = 900, H = 180, PAD = 34;
  const max = Math.max(...rows.map((r) => r.costUsd), 1e-9);
  const x = (i) => PAD + (i / Math.max(rows.length - 1, 1)) * (W - PAD * 2);
  const y = (v) => H - PAD + 10 - (v / max) * (H - PAD * 1.5);
  const pts = rows.map((r, i) => x(i).toFixed(1) + "," + y(r.costUsd).toFixed(1)).join(" ");
  const labels = rows.filter((_, i) => rows.length <= 10 || i % Math.ceil(rows.length / 10) === 0 || i === rows.length - 1);
  el.innerHTML =
    '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto" role="img" aria-label="Daily cost">' +
    '<polyline fill="none" stroke="#d97757" stroke-width="2" points="' + pts + '"/>' +
    rows.map((r, i) => '<circle cx="' + x(i) + '" cy="' + y(r.costUsd) + '" r="2.5" fill="#d97757"><title>' + esc(r.key) + ": " + fmtUsd(r.costUsd) + '</title></circle>').join("") +
    labels.map((r) => '<text x="' + x(rows.indexOf(r)) + '" y="' + (H - 6) + '" text-anchor="middle">' + esc(r.key.slice(5)) + '</text>').join("") +
    '<text x="4" y="14">' + fmtUsd(max) + '</text>' +
    '</svg>';
}

async function sendJson(method, url, body) {
  const res = await fetch(url, { method: method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error || (url + " -> " + res.status));
  return data;
}
const postJson = (url, body) => sendJson("POST", url, body);
const putJson = (url, body) => sendJson("PUT", url, body);

function flash(id, msg, isError) {
  const el = document.getElementById(id);
  el.textContent = msg;
  el.className = "flash" + (isError ? " err" : "");
}

function renderAssets(el, cfg) {
  const section = (title, items) => {
    if (!items.length) return "";
    return '<h3 style="font-size:13px;margin:10px 0 4px">' + esc(title) + ' <span class="pill">' + items.length + '</span></h3>' +
      '<table>' + items.map((a) =>
        '<tr' + (a.enabled ? '' : ' style="opacity:0.55"') + '><td>' + esc(a.name) + (a.enabled ? '' : ' <span class="pill off">disabled</span>') + '</td>' +
        '<td style="color:var(--muted)">' + esc(a.description || "") + '</td>' +
        '<td class="num"><button class="btn asset-edit" data-file="' + esc(a.filePath) + '">Edit</button> ' +
        '<button class="btn asset-toggle" data-file="' + esc(a.filePath) + '" data-enabled="' + a.enabled + '">' + (a.enabled ? 'Disable' : 'Enable') + '</button></td></tr>'
      ).join("") + '</table>';
  };
  const html = section("Skills", cfg.skills) + section("Agents", cfg.agents) + section("Commands", cfg.commands);
  el.innerHTML = html || '<div class="empty">No skills, agents or commands found.</div>';
}

function renderHooks(el, cfg) {
  let html = "";
  if (!cfg.hooks.length) html += '<div class="empty">No hooks configured.</div>';
  else {
    html += '<table><tr><th>Event</th><th>Matcher</th><th>Command</th><th>Source</th><th></th></tr>' +
      cfg.hooks.map((h, i) =>
        '<tr' + (h.enabled ? '' : ' style="opacity:0.55"') + '><td>' + esc(h.event) + (h.enabled ? '' : ' <span class="pill off">off</span>') + '</td><td>' + esc(h.matcher || "*") + '</td>' +
        '<td><code>' + esc(h.command || h.type) + '</code></td><td style="color:var(--muted)">' + esc(h.source) + '</td>' +
        '<td class="num"><button class="btn hook-toggle" data-i="' + i + '">' + (h.enabled ? 'Disable' : 'Enable') + '</button></td></tr>'
      ).join("") + '</table>';
  }
  html += '<h3 style="font-size:13px;margin:12px 0 4px">MCP servers <span class="pill">' + cfg.mcpServers.length + '</span></h3>';
  html += cfg.mcpServers.length
    ? '<table>' + cfg.mcpServers.map((s) =>
        '<tr><td>' + esc(s.name) + '</td><td><code>' + esc(s.url || s.command || "?") + '</code></td><td style="color:var(--muted)">' + esc(s.source) + '</td></tr>'
      ).join("") + '</table>'
    : '<div class="empty">No MCP servers configured.</div>';
  el.innerHTML = html;
  el._hooks = cfg.hooks;
}

async function render() {
  const days = document.getElementById("range").value;
  const q = days === "0" ? "" : "?days=" + days;
  const [summary, project, model, mcp, subagent, date, cfg] = await Promise.all([
    fetchJson("/api/summary" + q),
    fetchJson("/api/top" + (q ? q + "&" : "?") + "by=project"),
    fetchJson("/api/top" + (q ? q + "&" : "?") + "by=model"),
    fetchJson("/api/top" + (q ? q + "&" : "?") + "by=mcp"),
    fetchJson("/api/top" + (q ? q + "&" : "?") + "by=subagent"),
    fetchJson("/api/top" + (q ? q + "&" : "?") + "by=date"),
    fetchJson("/api/config"),
  ]);

  document.getElementById("summary-cards").innerHTML =
    card("Total cost", fmtUsd(summary.costUsd), summary.turns + " assistant turns") +
    card("Sessions", String(summary.sessions), summary.projects + " projects") +
    card("Input tokens", fmtTok(summary.inputTokens), "cache read " + fmtTok(summary.cacheReadTokens)) +
    card("Output tokens", fmtTok(summary.outputTokens), "cache write " + fmtTok(summary.cacheCreationTokens));

  lineChart(document.getElementById("daily-chart"), date);
  barList(document.getElementById("by-project"), project);
  barList(document.getElementById("by-model"), model, { alt: true });
  barList(document.getElementById("by-mcp"), mcp.filter((r) => r.key !== "(no-mcp)"));
  barList(document.getElementById("by-subagent"), subagent, { alt: true });
  renderAssets(document.getElementById("assets"), cfg);
  renderHooks(document.getElementById("hooks"), cfg);
  document.getElementById("data-dir").textContent = summary.dataDir;
}

document.getElementById("range").addEventListener("change", () => { render().catch(console.error); });

document.getElementById("assets").addEventListener("click", (ev) => {
  const editBtn = ev.target.closest("button.asset-edit");
  if (editBtn) { openEditor(editBtn.dataset.file); return; }
  const btn = ev.target.closest("button.asset-toggle");
  if (!btn) return;
  const enable = btn.dataset.enabled !== "true";
  postJson("/api/assets/toggle", { filePath: btn.dataset.file, enabled: enable })
    .then(() => { flash("assets-flash", (enable ? "Enabled" : "Disabled") + "."); return render(); })
    .catch((err) => flash("assets-flash", err.message, true));
});

let editorFile = null;
function openEditor(file) {
  fetchJson("/api/assets/content?filePath=" + encodeURIComponent(file))
    .then((r) => {
      editorFile = r.filePath;
      document.getElementById("editor-file").textContent = r.filePath;
      document.getElementById("editor-text").value = r.content;
      document.getElementById("editor-panel").classList.add("open");
      flash("editor-flash", "");
      document.getElementById("editor-panel").scrollIntoView({ behavior: "smooth" });
    })
    .catch((err) => flash("assets-flash", err.message, true));
}

document.getElementById("editor-save").addEventListener("click", () => {
  if (!editorFile) return;
  putJson("/api/assets/content", { filePath: editorFile, content: document.getElementById("editor-text").value })
    .then((r) => flash("editor-flash", "Saved " + r.bytes + " bytes."))
    .catch((err) => flash("editor-flash", err.message, true));
});

document.getElementById("editor-cancel").addEventListener("click", () => {
  editorFile = null;
  document.getElementById("editor-panel").classList.remove("open");
});

document.getElementById("new-create").addEventListener("click", () => {
  const kind = document.getElementById("new-kind").value;
  const name = document.getElementById("new-name").value.trim();
  if (!name) { flash("assets-flash", "Enter a name first.", true); return; }
  postJson("/api/assets/new", { kind: kind, name: name })
    .then((r) => { document.getElementById("new-name").value = ""; flash("assets-flash", "Created " + r.filePath + " — edit it to fill in the details."); return render(); })
    .catch((err) => flash("assets-flash", err.message, true));
});

document.getElementById("hooks").addEventListener("click", (ev) => {
  const btn = ev.target.closest("button.hook-toggle");
  if (!btn) return;
  const h = document.getElementById("hooks")._hooks[Number(btn.dataset.i)];
  if (!h) return;
  postJson("/api/hooks/toggle", { source: h.source, event: h.event, matcher: h.matcher, command: h.command, enabled: !h.enabled })
    .then(() => { flash("hooks-flash", (h.enabled ? "Disabled" : "Enabled") + " " + h.event + " hook."); return render(); })
    .catch((err) => flash("hooks-flash", err.message, true));
});

render().catch((err) => {
  document.body.insertAdjacentHTML("beforeend", '<div class="panel">Failed to load: ' + esc(err.message) + '</div>');
});
</script>
</body>
</html>
`;
