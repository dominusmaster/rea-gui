// End-to-end test of the chat agent: fake Anthropic API + fake MCP server, no network or API key needed.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = 4598;
const bin = fileURLToPath(new URL("../bin/rea-gui.mjs", import.meta.url));
const fake = fileURLToPath(new URL("./fake-mcp.mjs", import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- fake Messages API ----------
const requests = [];
function sse(res, events) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  res.end();
}
function reply(blocks, stopReason) {
  const events = [{ type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } }];
  blocks.forEach((b, index) => {
    if (b.type === "text") {
      events.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
      events.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: b.text } });
    } else {
      events.push({ type: "content_block_start", index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
      events.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } });
    }
    events.push({ type: "content_block_stop", index });
  });
  events.push({ type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: 5 } });
  events.push({ type: "message_stop" });
  return events;
}
const anthropic = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  requests.push({ body, beta: req.headers["anthropic-beta"] });
  const last = body.messages.at(-1);
  const toolResult = Array.isArray(last.content) && last.content.find((c) => c.type === "tool_result");
  if (toolResult) return sse(res, reply([{ type: "text", text: `Tool said: ${toolResult.content}` }], "end_turn"));
  sse(res, reply([{ type: "text", text: "Let me look. " }, { type: "tool_use", id: "toolu_1", name: "inspect_desktop_application", input: { path: "/Applications/X.app" } }], "tool_use"));
});
await new Promise((r) => anthropic.listen(0, "127.0.0.1", r));

const child = spawn(process.execPath, [bin, "--port", String(port), "--no-open"], {
  env: { ...process.env, REA_BIN: fake, REA_NODE: process.execPath, ANTHROPIC_BASE_URL: `http://127.0.0.1:${anthropic.address().port}`, ANTHROPIC_API_KEY: "", REA_GUI_DATA_DIR: join(tmpdir(), `rea-gui-chat-${process.pid}`) },
  stdio: ["ignore", "pipe", "inherit"],
});
const base = `http://127.0.0.1:${port}`;

try {
  let html;
  for (let i = 0; i < 50 && !html; i++) {
    await sleep(100);
    html = await fetch(base).then((r) => r.text()).catch(() => null);
  }
  const token = html.match(/name="rea-gui-token" content="([0-9a-f]+)"/)[1];
  const api = (path, init = {}) =>
    fetch(base + path, { ...init, headers: { "x-rea-gui-token": token, "content-type": "application/json" } }).then(async (r) => ({ status: r.status, body: await r.json() }));
  for (let i = 0; i < 50 && (await api("/api/status")).body.state !== "ready"; i++) await sleep(100);

  const config = (await api("/api/chat/config")).body;
  assert.ok(config.models.length && config.agents.length && config.efforts.includes("high"), "config");
  assert.equal((await api("/api/chat/sessions", { method: "POST", body: "{}" })).status, 400, "key required");

  const created = await api("/api/chat/sessions", { method: "POST", body: JSON.stringify({ apiKey: "sk-test", model: "claude-opus-5-5", agent: "rea-assistant" }) });
  assert.equal(created.status, 201);
  const id = created.body.id;
  assert.equal((await api(`/api/chat/sessions/${id}/message`, { method: "POST", body: JSON.stringify({ message: "Inspect X", effort: "high" }) })).status, 202);

  let log;
  for (let i = 0; i < 100; i++) {
    await sleep(50);
    const stream = await fetch(`${base}/api/chat/sessions/${id}/stream?token=${token}`);
    const reader = stream.body.getReader();
    const { value } = await reader.read();
    reader.cancel();
    const reset = new TextDecoder().decode(value).match(/event: reset\ndata: (.*)\n/);
    log = JSON.parse(reset[1]);
    if (log.events.some((e) => e.type === "turn_end")) break;
  }
  const types = log.events.map((e) => e.type);
  assert.ok(!types.includes("error"), `no errors: ${JSON.stringify(log.events.filter((e) => e.type === "error"))}`);
  assert.deepEqual(types.filter((t) => t.startsWith("tool_")), ["tool_start", "tool_end"]);
  const finalText = log.events.filter((e) => e.type === "text").at(-1).text;
  assert.match(finalText, /Tool said: .*X\.app/, "tool result reached the model");
  assert.equal(log.title, "Inspect X");

  const first = requests[0].body;
  assert.equal(first.tools[0].type, "tool_search_tool_regex_20251119", "tool search first");
  // The agent's starter tools load up front; everything else waits for tool search.
  const starters = new Set(["open_binary", "binary_session", "inspect_macho", "inspect_signature", "inspect_artifact", "inspect_analysis_view"]);
  assert.ok(first.tools.slice(1).every((t) => Boolean(t.defer_loading) === !starters.has(t.name)), "only starter tools load up front");
  assert.deepEqual(first.thinking, { type: "adaptive", display: "summarized" });
  assert.deepEqual(first.output_config, { effort: "high" });
  assert.equal(first.fallbacks, "default");
  assert.match(requests[0].beta, /server-side-fallback-2026-07-01/);
  // Append-only history: the second request extends the first.
  const second = requests[1].body.messages;
  assert.equal(second.length, 3);
  assert.equal(second[1].content.find((b) => b.type === "tool_use").input.path, "/Applications/X.app");

  assert.equal((await api(`/api/chat/sessions/${id}`, { method: "DELETE" })).status, 200);

  // A chat scoped to one analysis carries its context in the system prompt.
  const scoped = await api("/api/chat/sessions", {
    method: "POST",
    body: JSON.stringify({ apiKey: "sk-test", agent: "rea-assistant", context: "## This conversation\n- Path: /Applications/X.app", scope: "analysis:a1" }),
  });
  assert.equal(scoped.body.scope, "analysis:a1");
  const before = requests.length;
  await api(`/api/chat/sessions/${scoped.body.id}/message`, { method: "POST", body: JSON.stringify({ message: "What can it access?" }) });
  for (let i = 0; i < 100 && requests.length === before; i++) await sleep(50);
  const system = JSON.stringify(requests[before].body.system);
  assert.match(system, /Path: \/Applications\/X\.app/, "scoped context reaches the system prompt");
  assert.ok((await api("/api/chat/sessions")).body.sessions.some((x) => x.scope === "analysis:a1"), "scope listed");
  console.log("chat test passed");
} finally {
  child.kill();
  anthropic.close();
}
