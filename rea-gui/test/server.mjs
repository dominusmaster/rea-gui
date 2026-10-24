// Server deployment: refuses to listen publicly without a password, then guards everything behind sign-in.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const port = 4596;
const bin = fileURLToPath(new URL("../bin/rea-gui.mjs", import.meta.url));
const fake = fileURLToPath(new URL("./fake-mcp.mjs", import.meta.url));
const dataDir = mkdtempSync(join(tmpdir(), "rea-gui-server-"));
const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = { ...process.env, REA_BIN: fake, REA_NODE: process.execPath, REA_GUI_DATA_DIR: dataDir, REA_GUI_PASSWORD: "", REA_GUI_ALLOW_NO_PASSWORD: "" };

// No password on a public address: refuse, and say why.
const refused = spawnSync(process.execPath, [bin, "--host", "0.0.0.0", "--port", String(port), "--no-open"], { env, encoding: "utf8", timeout: 10000 });
assert.equal(refused.status, 1, "refuses to start");
assert.match(refused.stderr, /REA_GUI_PASSWORD/);

const child = spawn(process.execPath, [bin, "--port", String(port), "--no-open"], {
  env: { ...env, REA_GUI_HOST: "0.0.0.0", REA_GUI_PASSWORD: "correct horse", REA_GUI_MAX_UPLOAD_MB: "1" },
  stdio: ["ignore", "ignore", "inherit"],
});
try {
  for (let i = 0; i < 50; i++) {
    if (await fetch(`${base}/healthz`).then((r) => r.ok).catch(() => false)) break;
    await sleep(100);
  }
  assert.equal((await fetch(`${base}/healthz`)).status, 200, "health check needs no sign-in");

  // Signed out: the page redirects, the API refuses, only the sign-in page and its assets load.
  const page = await fetch(base, { redirect: "manual", headers: { host: "rea.example.com" } });
  assert.equal(page.status, 302, "any host name is accepted; the password protects the server");
  assert.equal(page.headers.get("location"), "/login.html");
  assert.equal((await fetch(`${base}/login.html`)).status, 200);
  assert.equal((await fetch(`${base}/style.css`)).status, 200);
  assert.equal((await fetch(`${base}/app.js`)).status, 404, "app code needs sign-in");
  const api = await fetch(`${base}/api/status`);
  assert.equal(api.status, 401);
  assert.equal((await api.json()).signIn, true);

  const login = (password) => fetch(`${base}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
  assert.equal((await login("wrong")).status, 401);
  const ok = await login("correct horse");
  assert.equal(ok.status, 200);
  const cookie = ok.headers.get("set-cookie").split(";")[0];
  assert.match(ok.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);

  const html = await (await fetch(base, { headers: { cookie } })).text();
  assert.match(html, /name="rea-gui-mode" content="server"/);
  assert.match(html, /name="rea-gui-auth" content="password"/);
  const token = html.match(/name="rea-gui-token" content="([0-9a-f]+)"/)[1];
  const headers = { cookie, "x-rea-gui-token": token };
  assert.equal((await fetch(`${base}/api/status`, { headers: { cookie } })).status, 401, "the page token is still required");
  assert.equal((await fetch(`${base}/api/status`, { headers })).status, 200);

  // Uploads keep the file name, in their own folder; oversized ones leave nothing behind.
  const up = await fetch(`${base}/api/upload?name=${encodeURIComponent("../evil/app.apk")}`, { method: "POST", headers, body: Buffer.from("PK\x03\x04hello") });
  assert.equal(up.status, 201);
  const saved = await up.json();
  assert.ok(saved.path.startsWith(join(dataDir, "uploads")), "stays inside the uploads folder");
  assert.equal(saved.name, ".._evil_app.apk".replace(/^\.+/, ""), "path separators can't escape");
  assert.equal(readFileSync(saved.path, "utf8"), "PK\x03\x04hello");
  assert.equal((await (await fetch(`${base}/api/detect?path=${encodeURIComponent(saved.path)}`, { headers })).json()).exists, true);
  const big = await fetch(`${base}/api/upload?name=big.bin`, { method: "POST", headers, body: Buffer.alloc(2 * 1024 * 1024) }).catch((err) => ({ status: "closed", err }));
  assert.ok(big.status === 413 || big.status === "closed", `oversized upload refused (${big.status})`);
  await sleep(200);
  assert.equal(readdirSync(join(dataDir, "uploads")).length, 1, "nothing left from the refused upload");

  // Sign out ends the session.
  await fetch(`${base}/api/logout`, { method: "POST", headers });
  // The browser drops the cookie; the old value no longer works either.
  assert.equal((await fetch(`${base}/api/status`, { headers })).status, 401, "session ended");

  // Repeated wrong passwords are slowed down.
  let status;
  for (let i = 0; i < 12; i++) status = (await login("nope")).status;
  assert.equal(status, 429);
  console.log("server test passed");
} finally {
  child.kill();
  rmSync(dataDir, { recursive: true, force: true });
}
