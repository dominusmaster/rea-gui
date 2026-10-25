// End-to-end test of the chat agent: fake Anthropic API + fake MCP server, no network or API key needed.
import { spawn } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Json, apiClient, must, pageToken, portOf, readReset, sleep } from "./helpers.ts";

const port = 4598;
const bin = fileURLToPath(new URL("../dist/bin/rea-gui.js", import.meta.url));
const fake = fileURLToPath(new URL("./fake-mcp.ts", import.meta.url));

// ---------- fake Messages API ----------
const requests: Json[] = [];
function sse(res: ServerResponse, events: Json[]) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  res.end();
}
function reply(blocks: Json[], stopReason: string) {
  const events: Json[] = [{ type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } }];
  blocks.forEach((b: Json, index: number) => {
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
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  requests.push({ body, beta: req.headers["anthropic-beta"] });
  const last = body.messages.at(-1);
  const toolResult = Array.isArray(last.content) && last.content.find((c: Json) => c.type === "tool_result");
  if (toolResult) return sse(res, reply([{ type: "text", text: `Tool said: ${toolResult.content}` }], "end_turn"));
  sse(res, reply([{ type: "text", text: "Let me look. " }, { type: "tool_use", id: "toolu_1", name: "inspect_desktop_application", input: { path: "/Applications/X.app" } }], "tool_use"));
});
await new Promise<void>((r) => anthropic.listen(0, "127.0.0.1", r));

// ---------- fake OpenRouter (Chat Completions) ----------
const orRequests: Json[] = [];
const chunk = (delta: Json, finish: string | null = null) => ({ id: "gen-1", choices: [{ index: 0, delta, finish_reason: finish }] });
function orStream(res: ServerResponse, chunks: Json[]) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(": OPENROUTER PROCESSING\n\n");
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  res.end("data: [DONE]\n\n");
}
const openrouter = createServer(async (req, res) => {
  if (req.url?.startsWith("/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(
      JSON.stringify({
        data: [
          { id: "acme/thinker", name: "Acme Thinker", context_length: 200000, pricing: { prompt: "0.000003", completion: "0.000015" }, supported_parameters: ["tools", "reasoning"], top_provider: { max_completion_tokens: 16000 } },
          { id: "acme/no-tools", name: "Acme Plain", pricing: { prompt: "0", completion: "0" }, supported_parameters: ["temperature"] },
        ],
      }),
    );
  }
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  orRequests.push({ body, auth: req.headers.authorization });
  const last = body.messages.at(-1);
  if (last.role === "user")
    return orStream(res, [
      chunk({ reasoning: "Need a tool. ", reasoning_details: [{ type: "reasoning.text", text: "Need a ", index: 0, format: "unknown" }] }),
      chunk({ reasoning_details: [{ type: "reasoning.text", text: "tool. ", index: 0 }] }),
      chunk({ content: "Searching. " }),
      chunk({ tool_calls: [{ index: 0, id: "call_s", type: "function", function: { name: "search_tools", arguments: '{"query":' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '"desktop app"}' } }] }, "tool_calls"),
    ]);
  if (body.messages.filter((m: Json) => m.role === "tool").length === 1)
    return orStream(res, [chunk({ tool_calls: [{ index: 0, id: "call_t", type: "function", function: { name: "inspect_desktop_application", arguments: '{"path":"/Applications/X.app"}' } }] }, "tool_calls")]);
  orStream(res, [chunk({ content: `Tool said: ${last.content}` }), chunk({}, "stop")]);
});
await new Promise<void>((r) => openrouter.listen(0, "127.0.0.1", r));

const child = spawn(process.execPath, [bin, "--port", String(port), "--no-open"], {
  env: { ...process.env, REA_BIN: fake, REA_NODE: process.execPath, ANTHROPIC_BASE_URL: `http://127.0.0.1:${portOf(anthropic)}`, ANTHROPIC_API_KEY: "", OPENROUTER_API_KEY: "", OPENROUTER_BASE_URL: `http://127.0.0.1:${portOf(openrouter)}`, OPENAI_API_KEY: "", OPENAI_BASE_URL: `http://127.0.0.1:${portOf(openrouter)}`, REA_GUI_DATA_DIR: join(tmpdir(), `rea-gui-chat-${process.pid}`) },
  stdio: ["ignore", "pipe", "inherit"],
});
const base = `http://127.0.0.1:${port}`;

try {
  let html;
  for (let i = 0; i < 50 && !html; i++) {
    await sleep(100);
    html = await fetch(base).then((r) => r.text()).catch(() => null);
  }
  const token = pageToken(html);
  const api = apiClient(base, token);
  for (let i = 0; i < 50 && (await api("/api/status")).body.state !== "ready"; i++) await sleep(100);

  const config = (await api("/api/chat/config")).body;
  assert.ok(config.models.length && config.agents.length && config.efforts.includes("high"), "config");
  assert.equal((await api("/api/chat/sessions", { method: "POST", body: "{}" })).status, 400, "key required");

  const created = await api("/api/chat/sessions", { method: "POST", body: JSON.stringify({ apiKey: "sk-test", model: "claude-opus-5-5", agent: "rea-assistant" }) });
  assert.equal(created.status, 201);
  const id = created.body.id;
  assert.equal((await api(`/api/chat/sessions/${id}/message`, { method: "POST", body: JSON.stringify({ message: "Inspect X", effort: "high" }) })).status, 202);

  let log: Json;
  for (let i = 0; i < 100; i++) {
    await sleep(50);
    log = await readReset(`${base}/api/chat/sessions/${id}/stream?token=${token}`);
    if (log.events.some((e: Json) => e.type === "turn_end")) break;
  }
  const types = log.events.map((e: Json) => e.type);
  assert.ok(!types.includes("error"), `no errors: ${JSON.stringify(log.events.filter((e: Json) => e.type === "error"))}`);
  assert.deepEqual(types.filter((t: Json) => t.startsWith("tool_")), ["tool_start", "tool_end"]);
  const finalText = log.events.filter((e: Json) => e.type === "text").at(-1).text;
  assert.match(finalText, /Tool said: .*X\.app/, "tool result reached the model");
  assert.equal(log.title, "Inspect X");

  const first = requests[0].body;
  assert.equal(first.tools[0].type, "tool_search_tool_regex_20251119", "tool search first");
  // The agent's starter tools load up front; everything else waits for tool search.
  const starters = new Set(["open_binary", "binary_session", "inspect_macho", "inspect_signature", "inspect_artifact", "inspect_analysis_view"]);
  assert.ok(first.tools.slice(1).every((t: Json) => Boolean(t.defer_loading) === !starters.has(t.name)), "only starter tools load up front");
  assert.deepEqual(first.thinking, { type: "adaptive", display: "summarized" });
  assert.deepEqual(first.output_config, { effort: "high" });
  assert.equal(first.fallbacks, "default");
  assert.match(requests[0].beta, /server-side-fallback-2026-07-01/);
  // Append-only history: the second request extends the first.
  const second = requests[1].body.messages;
  assert.equal(second.length, 3);
  assert.equal(second[1].content.find((b: Json) => b.type === "tool_use").input.path, "/Applications/X.app");

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
  assert.ok((await api("/api/chat/sessions")).body.sessions.some((x: Json) => x.scope === "analysis:a1"), "scope listed");

  // ---------- OpenRouter ----------
  const providers = (await api("/api/chat/config")).body.providers.map((p: Json) => p.id);
  assert.deepEqual(providers, ["anthropic", "openai", "gemini", "xai", "deepseek", "openrouter"]);
  const models = (await api("/api/chat/models", { method: "POST", body: JSON.stringify({ provider: "openrouter", apiKey: "sk-or-test" }) })).body.models;
  assert.deepEqual(models.map((m: Json) => m.id), ["acme/thinker"], "only tool-capable models are listed");
  assert.match(models[0].note, /\$3\.00 in · \$15\.00 out/);
  assert.equal((await api("/api/chat/sessions", { method: "POST", body: JSON.stringify({ provider: "openrouter", model: "acme/thinker" }) })).status, 400, "OpenRouter key required");
  assert.equal((await api("/api/chat/sessions", { method: "POST", body: JSON.stringify({ provider: "openrouter", apiKey: "sk-or-test" }) })).status, 400, "model required");
  const or = await api("/api/chat/sessions", { method: "POST", body: JSON.stringify({ provider: "openrouter", apiKey: "sk-or-test", model: "acme/thinker", agent: "rea-assistant" }) });
  assert.equal(or.status, 201);
  assert.equal(or.body.provider, "openrouter");
  await api(`/api/chat/sessions/${or.body.id}/message`, { method: "POST", body: JSON.stringify({ message: "Inspect X", effort: "medium" }) });
  let orLog: Json;
  for (let i = 0; i < 100; i++) {
    await sleep(50);
    orLog = await readReset(`${base}/api/chat/sessions/${or.body.id}/stream?token=${token}`);
    if (orLog.events.some((e: Json) => e.type === "turn_end")) break;
  }
  const orTypes = orLog.events.map((e: Json) => e.type);
  assert.ok(!orTypes.includes("error"), `no errors: ${JSON.stringify(orLog.events.filter((e: Json) => e.type === "error"))}`);
  assert.equal(orLog.events.find((e: Json) => e.type === "thinking").text, "Need a tool. ", "reasoning streams to the browser");
  assert.deepEqual(orLog.events.find((e: Json) => e.type === "tool_search_result").tools, ["inspect_desktop_application"]);
  assert.deepEqual(orTypes.filter((t: Json) => t.startsWith("tool_") && t !== "tool_search_query"), ["tool_search", "tool_search_result", "tool_start", "tool_end"]);
  assert.match(orLog.events.filter((e: Json) => e.type === "text").at(-1).text, /Tool said: .*X\.app/, "tool result reached the model");

  assert.equal(orRequests.length, 3);
  const [r1, r2] = orRequests;
  assert.equal(r1.auth, "Bearer sk-or-test");
  assert.equal(r1.body.model, "acme/thinker");
  assert.deepEqual(r1.body.reasoning, { effort: "medium" }, "reasoning requested for a reasoning model");
  assert.equal(r1.body.max_tokens, 16000, "capped at the model's output limit");
  assert.equal(r1.body.messages[0].role, "system");
  const names = (r: Json) => r.body.tools.map((t: Json) => t.function.name);
  assert.deepEqual(names(r1), ["search_tools", "open_binary", "binary_session", "inspect_signature"], "search plus available starters only");
  assert.ok(names(r2).includes("inspect_desktop_application"), "found tools are sent on the next request");
  const assistant = r2.body.messages.find((m: Json) => m.role === "assistant");
  assert.deepEqual(assistant.reasoning_details, [{ type: "reasoning.text", text: "Need a tool. ", index: 0, format: "unknown" }], "reasoning is passed back, joined");
  assert.equal(assistant.tool_calls[0].function.arguments, '{"query":"desktop app"}', "streamed arguments are joined");
  assert.equal(r2.body.messages.at(-1).role, "tool");
  assert.equal(r2.body.messages.at(-1).tool_call_id, "call_s");

  // ---------- OpenAI-compatible providers (same fake server) ----------
  assert.equal((await api("/api/chat/models", { method: "POST", body: JSON.stringify({ provider: "openai" }) })).status, 502, "OpenAI's list needs a key");
  const oaModels = (await api("/api/chat/models", { method: "POST", body: JSON.stringify({ provider: "openai", apiKey: "sk-oa" }) })).body.models;
  assert.deepEqual(oaModels, [], "non-OpenAI ids are filtered out");
  orRequests.length = 0;
  const oa = await api("/api/chat/sessions", { method: "POST", body: JSON.stringify({ provider: "openai", apiKey: "sk-oa", model: "gpt-test", agent: "rea-assistant" }) });
  assert.equal(oa.status, 201);
  await api(`/api/chat/sessions/${oa.body.id}/message`, { method: "POST", body: JSON.stringify({ message: "Inspect X", effort: "medium" }) });
  for (let i = 0; i < 100 && orRequests.length < 3; i++) await sleep(50);
  assert.equal(orRequests[0].auth, "Bearer sk-oa");
  assert.equal(orRequests[0].body.max_tokens, undefined, "no output cap for direct providers");
  assert.equal(orRequests[0].body.reasoning, undefined, "no OpenRouter-only fields");
  const oaAssistant = orRequests[1].body.messages.find((m: Json) => m.role === "assistant");
  assert.equal(oaAssistant.reasoning_details, undefined, "OpenRouter reasoning isn't sent to OpenAI");
  console.log("chat test passed");
} finally {
  child.kill();
  anthropic.close();
  openrouter.close();
}
