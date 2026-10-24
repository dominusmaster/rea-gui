// End-to-end smoke test of the HTTP bridge against the fake MCP server.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";

const port = 4599;
const bin = fileURLToPath(new URL("../bin/rea-gui.mjs", import.meta.url));
const fake = fileURLToPath(new URL("./fake-mcp.mjs", import.meta.url));
const child = spawn(process.execPath, [bin, "--port", String(port), "--no-open"], {
  env: { ...process.env, REA_BIN: fake, REA_NODE: process.execPath, REA_GUI_DATA_DIR: join(tmpdir(), `rea-gui-smoke-${process.pid}`) },
  stdio: ["ignore", "pipe", "inherit"],
});
const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  let html;
  for (let i = 0; i < 50 && !html; i++) {
    await sleep(100);
    html = await fetch(base).then((r) => r.text()).catch(() => null);
  }
  const token = html.match(/name="rea-gui-token" content="([0-9a-f]+)"/)[1];
  const api = (path, init = {}) =>
    fetch(base + path, { ...init, headers: { "x-rea-gui-token": token, "content-type": "application/json" } }).then(async (r) => ({ status: r.status, body: await r.json() }));

  assert.equal((await fetch(`${base}/api/status`)).status, 401, "token required");
  const rebound = await new Promise((resolve) =>
    request({ host: "127.0.0.1", port, path: "/", headers: { host: "evil.example:4599" } }, (res) => resolve(res.statusCode)).end(),
  );
  assert.equal(rebound, 403, "host check");

  let status;
  for (let i = 0; i < 50; i++) {
    status = (await api("/api/status")).body;
    if (status.state === "ready" && status.toolCount) break;
    await sleep(100);
  }
  assert.equal(status.state, "ready");
  assert.equal(status.toolCount, 6);

  // REA has one open file. Calls racing to open and inspect different apps must each see their own app.
  for (let i = 0; i < 50 && !(await api("/api/session")).body.session; i++) await sleep(50);
  const finish = async (callId) => {
    for (let i = 0; i < 100; i++) {
      const r = (await api(`/api/calls/${callId}`)).body;
      if (r.state !== "running") return r;
      await sleep(25);
    }
    throw new Error("call did not finish");
  };
  const post = (body) => api("/api/call", { method: "POST", body: JSON.stringify(body) }).then((r) => r.body.callId);
  const [openA, sigB, sigA] = await Promise.all([
    post({ name: "open_binary", arguments: { path: "/Apps/A.app" } }),
    post({ name: "inspect_signature", arguments: {}, target: "/Apps/B.app" }),
    post({ name: "inspect_signature", arguments: {}, target: "/Apps/A.app/Contents/MacOS/a" }),
  ]);
  await finish(openA);
  assert.equal((await finish(sigB)).result.structuredContent.signed_path, "/Apps/B.app", "B's check ran on B");
  assert.equal((await finish(sigA)).result.structuredContent.signed_path, "/Apps/A.app/Contents/MacOS/a", "A's check ran on A");

  const { body: call } = await api("/api/call", { method: "POST", body: JSON.stringify({ name: "inspect_desktop_application", arguments: { path: "/x" } }) });
  let record;
  for (let i = 0; i < 50; i++) {
    record = (await api(`/api/calls/${call.callId}`)).body;
    if (record.state !== "running") break;
    await sleep(50);
  }
  assert.equal(record.state, "done");
  assert.deepEqual(record.result.structuredContent, { echoed: { path: "/x" } });

  const { body: slow } = await api("/api/call", { method: "POST", body: JSON.stringify({ name: "slow_tool", arguments: {} }) });
  await sleep(200);
  assert.equal((await api(`/api/calls/${slow.callId}`)).body.progress.message, "halfway");
  await api(`/api/calls/${slow.callId}/cancel`, { method: "POST" });
  await sleep(100);
  assert.equal((await api(`/api/calls/${slow.callId}`)).body.state, "error", "cancel");

  assert.equal((await api("/api/call", { method: "POST", body: JSON.stringify({ name: "nope" }) })).status, 404);
  // Tool arguments can carry whole evidence records; a multi-megabyte call must go through.
  const big = await api("/api/call", { method: "POST", body: JSON.stringify({ name: "inspect_desktop_application", arguments: { path: "/x", blob: "x".repeat(3_000_000) } }) });
  assert.equal(big.status, 202, "large tool call accepted");
  assert.ok(Array.isArray((await api("/api/apps")).body.apps));
  assert.ok((await api("/api/fs?path=/")).body.items.length > 0);
  const binary = (await api(`/api/detect?path=${encodeURIComponent(process.execPath)}`)).body;
  assert.ok(binary.exists && !binary.dir && ["mach-o", "elf", "pe"].includes(binary.magic), "detect binary");
  assert.equal((await api("/api/detect?path=/definitely/missing")).body.exists, false, "detect missing");
  assert.equal((await api("/api/detect?path=/")).body.dir, true, "detect folder");
  assert.equal((await fetch(`${base}/missing.js`)).status, 404);
  const traversal = await new Promise((resolve) =>
    request({ host: "127.0.0.1", port, path: "/%2e%2e/package.json" }, (res) => resolve(res.statusCode)).end(),
  );
  assert.equal(traversal, 404, "path traversal");
  console.log("smoke: all checks passed");
} finally {
  child.kill();
}
