// Saved analyses survive a GUI restart, and one app keeps only its latest analysis.
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const port = 4597;
const bin = fileURLToPath(new URL("../bin/rea-gui.mjs", import.meta.url));
const fake = fileURLToPath(new URL("./fake-mcp.mjs", import.meta.url));
const dataDir = mkdtempSync(join(tmpdir(), "rea-gui-analyses-"));
const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch() {
  const child = spawn(process.execPath, [bin, "--port", String(port), "--no-open"], {
    env: { ...process.env, REA_BIN: fake, REA_NODE: process.execPath, REA_GUI_DATA_DIR: dataDir },
    stdio: ["ignore", "ignore", "inherit"],
  });
  let html;
  for (let i = 0; i < 50 && !html; i++) {
    await sleep(100);
    html = await fetch(base).then((r) => r.text()).catch(() => null);
  }
  const token = html.match(/name="rea-gui-token" content="([0-9a-f]+)"/)[1];
  const api = (path, init = {}) =>
    fetch(base + path, { ...init, headers: { "x-rea-gui-token": token, "content-type": "application/json" } }).then(async (r) => ({ status: r.status, body: await r.json() }));
  return { child, api };
}
const stop = (child) => new Promise((r) => (child.once("exit", r), child.kill()));

const record = { name: "inspect_signature", arguments: {}, state: "done", result: { content: [{ type: "text", text: JSON.stringify({ normalized_result: { signed: true } }) }] } };
const snapshot = (id, path, extra = {}) => ({ id, path, name: "X", kind: "mac-app", at: Date.now(), finishedAt: Date.now(), state: "done", reaSession: "old-1", detected: { path, exists: true }, steps: [{ id: "signature", status: "done", record }], ...extra });

let server = await launch();
try {
  let { api } = server;
  assert.deepEqual((await api("/api/analyses")).body.analyses, [], "starts empty");
  assert.equal((await api("/api/analyses/a12345", { method: "PUT", body: JSON.stringify(snapshot("a12345", "/Apps/X.app")) })).status, 200);
  assert.equal((await api("/api/analyses/a22222", { method: "PUT", body: JSON.stringify(snapshot("a22222", "/Apps/Y.app")) })).status, 200);
  assert.equal((await api("/api/analyses/../etc", { method: "PUT", body: "{}" })).status, 404, "path-like ids never reach the store");
  assert.equal((await api("/api/analyses/a33333", { method: "PUT", body: JSON.stringify(snapshot("a44444", "/Apps/Z.app")) })).status, 400, "id must match the URL");
  assert.equal((await api("/api/analyses/bad!", { method: "GET" })).status, 400);

  // Restart the whole GUI process: the analyses must still be there, with their results.
  await stop(server.child);
  server = await launch();
  api = server.api;
  const list = (await api("/api/analyses")).body.analyses;
  assert.deepEqual(list.map((a) => a.id).sort(), ["a12345", "a22222"], "list survives restart");
  assert.ok(!("steps" in list[0]), "list carries summaries only");
  const saved = (await api("/api/analyses/a12345")).body;
  assert.deepEqual(saved.steps[0].record, record, "results survive restart");
  assert.notEqual((await api("/api/status")).body.reaSession, "old-1", "a new REA run gets a new session id");

  // Re-analyzing the same app replaces its previous analysis, file included.
  await api("/api/analyses/a55555", { method: "PUT", body: JSON.stringify(snapshot("a55555", "/Apps/X.app")) });
  assert.deepEqual((await api("/api/analyses")).body.analyses.map((a) => a.id).sort(), ["a22222", "a55555"]);
  assert.equal((await api("/api/analyses/a12345")).status, 404);

  assert.equal((await api("/api/analyses/a22222", { method: "DELETE" })).status, 200);
  assert.equal((await api("/api/analyses/a22222", { method: "DELETE" })).status, 404);
  assert.deepEqual(readdirSync(join(dataDir, "analyses")).sort(), ["a55555.json", "index.json"], "no stray files");
  console.log("analyses test passed");
} finally {
  await stop(server.child);
  rmSync(dataDir, { recursive: true, force: true });
}
