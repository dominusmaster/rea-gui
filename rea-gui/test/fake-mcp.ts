// Fake MCP stdio server used by the smoke test; argv[2] is ignored ("mcp").
import { createInterface } from "node:readline";
import type { Json } from "./helpers.ts";
const send = (m: Json) => process.stdout.write(`${JSON.stringify(m)}\n`);
const tools = [
  {
    name: "inspect_desktop_application",
    description: "Fake desktop inspection",
    inputSchema: { type: "object", properties: { path: { type: "string" }, detail: { enum: ["summary", "complete"] } }, required: ["path"] },
  },
  { name: "slow_tool", description: "Sleeps", inputSchema: { type: "object", properties: {} } },
  // Like REA: one open file, and tools that act on whatever is open.
  { name: "open_binary", description: "Open a file", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "close_binary", description: "Close the file", inputSchema: { type: "object", properties: {} } },
  { name: "binary_session", description: "Session state", inputSchema: { type: "object", properties: {} } },
  { name: "inspect_signature", description: "Signature of the open file", inputSchema: { type: "object", properties: {} } },
];
let open: string | null = null;
const reply = (id: string, result: Json, delay = 0) => setTimeout(() => send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result } }), delay);
createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake-rea", version: "0.0.0" } } });
  else if (msg.method === "tools/list") send({ jsonrpc: "2.0", id: msg.id, result: { tools } });
  else if (msg.method === "tools/call" && msg.params.name === "slow_tool") {
    send({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: msg.params._meta.progressToken, progress: 1, total: 2, message: "halfway" } });
    setTimeout(() => send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "slept" }] } }), 5000);
  } else if (msg.method === "tools/call" && msg.params.name === "open_binary") {
    // Slow on purpose, so a racing call would see the old file.
    setTimeout(() => (open = msg.params.arguments.path), 150);
    reply(msg.id, { result: { path: msg.params.arguments.path, format: "mach-o" } }, 200);
  } else if (msg.method === "tools/call" && msg.params.name === "close_binary") {
    open = null;
    reply(msg.id, { result: { closed: true } });
  } else if (msg.method === "tools/call" && msg.params.name === "binary_session") {
    const targetTool = { names: ["inspect_signature"], available: Boolean(open), reason: open ? "available" : "target_required" };
    reply(msg.id, { result: { open: Boolean(open), path: open, format: "mach-o", tool_availability: { groups: [targetTool] } } });
  } else if (msg.method === "tools/call" && msg.params.name === "inspect_signature") {
    if (!open) return void reply(msg.id, { error: "no target" });
    const seen = open;
    reply(msg.id, { signed_path: seen }, 100);
  } else if (msg.method === "tools/call") {
    const structured = { echoed: msg.params.arguments };
    send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: JSON.stringify(structured) }], structuredContent: structured } });
  }
});
process.stderr.write("fake MCP server started\n");
