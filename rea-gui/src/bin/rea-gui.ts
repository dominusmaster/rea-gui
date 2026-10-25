#!/usr/bin/env node
// REA GUI: local web interface for the REA MCP server.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync } from "node:fs";
import { mkdir, open as openFile, readdir, rm, stat, readFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { homedir, platform, tmpdir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { McpError, McpStdioClient } from "../lib/mcp-client.js";
import { AnalysisStore, type AnalysisSnapshot } from "../lib/analyses.js";
import { PasswordAuth, isLoopback } from "../lib/auth.js";
import { TargetBroker, type BinarySession } from "../lib/target.js";
import { AnthropicSession, MODELS, EFFORTS, DEFAULT_EFFORT, PROVIDERS, publicAgents, type ChatEvent, type ChatSession, type SessionOptions } from "../lib/agent.js";
import { CompletionsSession, listModels, envKey, isCompatProvider, type ListedModel } from "../lib/completions.js";
import { errorMessage, type JsonObject, type McpTool, type ProgressParams, type ToolResult } from "../lib/types.js";

/** A JSON request body; every field is checked before use. */
type Body = Record<string, unknown>;
const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
/** An error that carries the HTTP status to answer with. */
const httpError = (message: string, status: number) => Object.assign(new Error(message), { status });

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(here, "..", "public");
const pkg = JSON.parse(readFileSync(resolve(here, "..", "..", "package.json"), "utf8")) as { version: string };

// ---------- CLI flags ----------
const argv = process.argv.slice(2);
const flag = (name: string): boolean => argv.includes(`--${name}`);
const option = (name: string, fallback: string): string => {
  const i = argv.indexOf(`--${name}`);
  return (i !== -1 && argv[i + 1]) || fallback;
};
if (flag("help") || flag("h")) {
  console.log(`rea-gui ${pkg.version}

Usage: rea-gui [--port N] [--host 127.0.0.1] [--no-open]

On a server, listen on all interfaces and set a password:
  REA_GUI_PASSWORD=… rea-gui --host 0.0.0.0 --no-open

Environment:
  REA_GUI_HOST, PORT        Same as --host and --port
  REA_GUI_PASSWORD  Required to listen on anything but 127.0.0.1
  REA_GUI_TRUST_PROXY=1     Behind a reverse proxy: trust X-Forwarded-For
  REA_GUI_MAX_UPLOAD_MB     Largest upload (default 4096)
  REA_BIN    Path to REA's scripts/rea.mjs or a rea executable
  REA_NODE   Node.js binary used to run REA (must satisfy REA's engines)
  REA_GUI_DATA_DIR  Where saved analyses live (default ~/.rea-gui)
  ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, XAI_API_KEY,
  DEEPSEEK_API_KEY, OPENROUTER_API_KEY  Chat keys, instead of entering them in the browser`);
  process.exit(0);
}
if (flag("version")) {
  console.log(pkg.version);
  process.exit(0);
}
const host = option("host", process.env.REA_GUI_HOST || "127.0.0.1");
const port = Number(option("port", process.env.PORT ?? "4517"));
const dataDir = process.env.REA_GUI_DATA_DIR || join(homedir(), ".rea-gui");
// On a server the page itself must be protected: anyone who loads it gets the API token.
const auth = process.env.REA_GUI_PASSWORD ? new PasswordAuth(process.env.REA_GUI_PASSWORD) : null;
const remote = !isLoopback(host);
if (remote && !auth && process.env.REA_GUI_ALLOW_NO_PASSWORD !== "1") {
  console.error(`Refusing to listen on ${host} without a password: anyone who reaches this address could read files and run REA tools on this machine.
Set REA_GUI_PASSWORD, or (only behind your own authenticating proxy) REA_GUI_ALLOW_NO_PASSWORD=1.`);
  process.exit(1);
}
const maxUpload = Number(process.env.REA_GUI_MAX_UPLOAD_MB || 4096) * 1024 * 1024;

// ---------- Locate REA and a compatible Node ----------
function nodeVersionSupported(version: string): boolean {
  const [major = 0, minor = 0] = version.replace(/^v/, "").split(".").map(Number);
  return (major === 22 && minor >= 19) || (major === 24 && minor >= 11) || major >= 26;
}

function versionOf(nodeBinary: string): string | null {
  const result = spawnSync(nodeBinary, ["--version"], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

function findNode(): string {
  if (process.env.REA_NODE) return process.env.REA_NODE;
  if (nodeVersionSupported(process.version)) return process.execPath;
  const candidates = [
    "/opt/homebrew/opt/node@24/bin/node",
    "/opt/homebrew/opt/node@22/bin/node",
    "/usr/local/opt/node@24/bin/node",
    "/usr/local/opt/node@22/bin/node",
  ];
  for (const candidate of candidates) {
    const version = existsSync(candidate) && versionOf(candidate);
    if (version && nodeVersionSupported(version)) return candidate;
  }
  console.warn(
    `! Node ${process.version} is outside REA's supported range (22.19+, 24.11+, 26+). ` +
      `Set REA_NODE to a supported node binary if REA fails to start.`,
  );
  return process.execPath;
}

function findReaScript(): string | null {
  if (process.env.REA_BIN) return process.env.REA_BIN;
  const roots = [here, process.cwd()];
  for (const root of roots) {
    let dir = root;
    while (true) {
      const candidate = join(dir, "node_modules", "rea-agents", "scripts", "rea.mjs");
      if (existsSync(candidate)) return candidate;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

function reaLaunch(): { command: string; args: string[]; label: string } {
  const node = findNode();
  const script = findReaScript();
  if (script && /\.[mc]?[jt]s$/.test(script)) return { command: node, args: [script, "mcp"], label: script };
  if (script) return { command: script, args: ["mcp"], label: script };
  return { command: "npx", args: ["-y", "rea-agents@latest", "mcp"], label: "npx rea-agents@latest" };
}

// ---------- MCP client lifecycle ----------
const launch = reaLaunch();
interface CallRecord {
  id: string;
  name: string;
  arguments: JsonObject;
  startedAt: number;
  finishedAt?: number;
  state: "running" | "done" | "error";
  progress: ProgressParams | null;
  target: string | null;
  result?: ToolResult;
  error?: { message: string; code?: number; data?: unknown };
  cancel: () => void;
}

interface ParsedSession extends BinarySession {
  open: boolean;
  target: { path: unknown; format: unknown; kind: unknown; architecture: unknown; sha256: unknown } | null;
  providers: { id: string; name: string; status: unknown; code: unknown; reason: unknown }[];
  binding: unknown;
  availability: Record<string, { available: boolean; reason?: string; remediation?: string }>;
}

interface Chat {
  session: ChatSession;
  log: ChatEvent[]; // events replayed to new streams
  streams: Set<ServerResponse>;
  createdAt: number;
  scope: string | null;
}

let client: McpStdioClient | null = null;
let tools: McpTool[] = [];
// Every tool call goes through the broker so callers can't switch REA's open file under each other.
const broker = new TargetBroker();
const sseClients = new Set<ServerResponse>();
const calls = new Map<string, CallRecord>();
let session: ParsedSession | null = null;
// Call IDs stay unique across REA restarts and GUI relaunches, unlike JSON-RPC request IDs.
const bootId = randomBytes(4).toString("hex");
let callSeq = 0;
// Identifies the running REA process. Evidence IDs from analyses only resolve in the run that made them.
let reaRun = 0;
const analyses = new AnalysisStore(join(dataDir, "analyses"));
let sessionRefresh: NodeJS.Timeout | undefined;

// ---------- Chat agent state ----------
const chats = new Map<string, Chat>();
let chatSeq = 0;

function chatSummary(id: string, chat: Chat) {
  const s = chat.session;
  return { id, provider: s.provider, agent: s.agent, model: s.model, title: s.title, busy: s.busy, createdAt: chat.createdAt, scope: chat.scope ?? null };
}

// Coalesce streamed text so a reconnecting browser replays whole blocks, not every delta.
function recordChatEvent(chat: Chat, event: ChatEvent): void {
  const last = chat.log.at(-1);
  if ((event.type === "text" || event.type === "thinking") && last?.type === event.type) last.text += event.text;
  else chat.log.push({ ...event });
  const payload = `event: chat\ndata: ${JSON.stringify(event)}\n\n`;
  for (const res of chat.streams) res.write(payload);
}

function broadcast(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) res.write(payload);
}

function statusSnapshot() {
  return {
    state: client?.state ?? "stopped",
    error: client?.error ?? null,
    serverInfo: client?.serverInfo ?? null,
    protocolVersion: client?.protocolVersion ?? null,
    toolCount: tools.length,
    reaSession: `${bootId}-${reaRun}`,
    launch: launch.label,
    guiVersion: pkg.version,
  };
}

async function startRea(): Promise<void> {
  client?.removeAllListeners();
  client?.stop();
  tools = [];
  session = null;
  broker.reset();
  reaRun++;
  const mcp = new McpStdioClient({
    command: launch.command,
    args: launch.args,
    env: { REA_MCP_INPUT_SCHEMA_PROFILE: "full", ...process.env },
  });
  client = mcp;
  mcp.on("status", () => broadcast("status", statusSnapshot()));
  mcp.on("stderr", (line: string) => broadcast("stderr", line));
  mcp.on("log", (params: unknown) => broadcast("log", params));
  try {
    await mcp.start();
    tools = await mcp.listTools();
    console.log(`✓ REA ${mcp.serverInfo?.version ?? ""} ready with ${tools.length} tools`);
    refreshSession();
  } catch (err) {
    console.error(`✗ Could not start REA: ${errorMessage(err)}`);
    for (const line of mcp.stderrTail.slice(-15)) console.error(`  ${line}`);
  }
  broadcast("status", statusSnapshot());
}

// binary_session reports the active target, provider readiness and per-tool availability.
// The parts of binary_session's result read here.
interface SessionData {
  open?: boolean;
  path?: unknown;
  format?: unknown;
  kind?: unknown;
  architecture?: unknown;
  sha256?: unknown;
  tool_availability?: { groups?: { names: string[]; available: boolean; reason?: string; remediation?: string }[] };
  analysis_provider_candidates?: { provider: { id: string; name: string }; availability?: { status?: unknown; code?: unknown; reason?: unknown } }[];
  analysis_provider_binding?: unknown;
}

function parseSession(result: ToolResult): ParsedSession | null {
  const text = result.content?.find((c) => c.type === "text")?.text;
  const structured = result.structuredContent as { result?: SessionData } | undefined;
  const data: SessionData | null = structured?.result ?? (text ? (JSON.parse(text) as { result?: SessionData }).result ?? null : null);
  if (!data) return null;
  const availability: ParsedSession["availability"] = {};
  for (const group of data.tool_availability?.groups ?? []) {
    for (const name of group.names) {
      availability[name] = { available: group.available, ...(group.reason ? { reason: group.reason } : {}), ...(group.remediation ? { remediation: group.remediation } : {}) };
    }
  }
  return {
    open: Boolean(data.open),
    target: data.open ? { path: data.path, format: data.format, kind: data.kind, architecture: data.architecture, sha256: data.sha256 } : null,
    providers: (data.analysis_provider_candidates ?? []).map((c) => ({
      id: c.provider.id,
      name: c.provider.name,
      status: c.availability?.status,
      code: c.availability?.code ?? null,
      reason: c.availability?.reason ?? null,
    })),
    binding: data.analysis_provider_binding ?? null,
    availability,
  };
}

function refreshSession(): void {
  const mcp = client;
  if (mcp?.state !== "ready" || !tools.some((t) => t.name === "binary_session")) return;
  clearTimeout(sessionRefresh);
  sessionRefresh = setTimeout(async () => {
    try {
      const { promise } = mcp.request<ToolResult>("tools/call", { name: "binary_session", arguments: {} });
      session = parseSession(await promise);
      broker.learn(session);
      broadcast("session", session);
    } catch (err) {
      broadcast("stderr", `[rea-gui] binary_session failed: ${errorMessage(err)}`);
    }
  }, 150);
}

function startCall(mcp: McpStdioClient, name: string, args: JsonObject, { target }: { target?: string | undefined } = {}): string {
  const id = `${bootId}-${++callSeq}`;
  const record: CallRecord = { id, name, arguments: args, startedAt: Date.now(), state: "running", progress: null, target: target ?? null, cancel: () => {} };
  const { promise, cancel } = broker.call(mcp, name, args, {
    target,
    onProgress: (progress) => {
      record.progress = progress;
      broadcast("progress", { callId: id, ...progress });
    },
  });
  record.cancel = cancel;
  calls.set(id, record);
  promise.then(
    (result) => Object.assign(record, { state: "done", result }),
    (err: unknown) =>
      Object.assign(record, {
        state: "error",
        error: err instanceof McpError ? { message: err.message, code: err.code, data: err.data } : { message: errorMessage(err) },
      }),
  ).finally(() => {
    record.finishedAt = Date.now();
    const outcome = record.result?.isError ? "error" : record.state;
    broadcast("call-finished", { callId: id, state: outcome });
    refreshSession();
    // Keep memory bounded: drop the oldest finished calls.
    const finished = [...calls.values()].filter((c) => c.state !== "running");
    for (const old of finished.slice(0, Math.max(0, finished.length - 60))) calls.delete(old.id);
  });
  return id;
}

// ---------- Local helpers for the UI ----------
async function listApplications() {
  const roots = platform() === "darwin" ? ["/Applications", join(homedir(), "Applications")] : [];
  const apps: { name: string; path: string; kind: "desktop" | "electron"; analyzePath: string }[] = [];
  for (const root of roots) {
    let entries: import("node:fs").Dirent[] = [];
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.name.endsWith(".app")) continue;
      const appPath = join(root, entry.name);
      const resources = join(appPath, "Contents", "Resources");
      const asar = join(resources, "app.asar");
      const unpacked = join(resources, "app");
      let kind: "desktop" | "electron" = "desktop";
      let analyzePath = appPath;
      if (existsSync(asar)) {
        kind = "electron";
        analyzePath = asar;
      } else if (existsSync(join(unpacked, "package.json"))) {
        kind = "electron";
        analyzePath = unpacked;
      }
      apps.push({ name: entry.name.replace(/\.app$/, ""), path: appPath, kind, analyzePath });
    }
  }
  return apps.sort((a, b) => a.name.localeCompare(b.name));
}

// App icon as a cached 64px PNG (macOS only; Asset-catalog-only icons are unsupported).
const iconCache = join(tmpdir(), "rea-gui-icons");
function appIcon(appPath: string | null): string | null {
  if (platform() !== "darwin" || !appPath?.endsWith(".app")) return null;
  const cached = join(iconCache, `${createHash("sha1").update(appPath).digest("hex")}.png`);
  if (existsSync(cached)) return cached;
  const plist = join(appPath, "Contents", "Info.plist");
  const iconName = spawnSync("plutil", ["-extract", "CFBundleIconFile", "raw", plist], { encoding: "utf8" }).stdout?.trim();
  if (!iconName) return null;
  const icns = join(appPath, "Contents", "Resources", iconName.endsWith(".icns") ? iconName : `${iconName}.icns`);
  if (!existsSync(icns)) return null;
  mkdirSync(iconCache, { recursive: true });
  const result = spawnSync("sips", ["-s", "format", "png", "-Z", "64", icns, "--out", cached], { stdio: "ignore" });
  return result.status === 0 && existsSync(cached) ? cached : null;
}

// Classify a path so the UI can pick an analysis without the user knowing REA's tool names.
const MAGIC: [string, (b: Buffer) => boolean][] = [
  ["mach-o", (b) => [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca].includes(b.readUInt32BE(0))],
  ["elf", (b) => b.readUInt32BE(0) === 0x7f454c46],
  ["pe", (b) => b[0] === 0x4d && b[1] === 0x5a],
  ["zip", (b) => b[0] === 0x50 && b[1] === 0x4b],
  ["wasm", (b) => b.readUInt32BE(0) === 0x0061736d],
  ["sqlite", (b) => b.toString("latin1", 0, 15) === "SQLite format 3"],
];
interface Detected {
  path: string;
  exists: boolean;
  name?: string;
  dir?: boolean;
  bytes?: number | null;
  magic?: string | null;
  electronAsar?: string | null;
  packageJson?: boolean;
  bundle?: boolean;
}

async function detectPath(input: string | null): Promise<Detected> {
  const path = resolve(String(input ?? "").trim().replace(/^~(?=$|\/)/, homedir()));
  let info;
  try {
    info = await stat(path);
  } catch {
    return { path, exists: false };
  }
  const name = path.split(sep).pop() ?? path;
  const ext = extname(name).toLowerCase();
  const result: Detected = { path, exists: true, name, dir: info.isDirectory(), bytes: info.isDirectory() ? null : info.size, magic: null, electronAsar: null, packageJson: false };
  if (info.isDirectory()) {
    const resources = join(path, "Contents", "Resources");
    if (existsSync(join(resources, "app.asar"))) result.electronAsar = join(resources, "app.asar");
    else if (existsSync(join(resources, "app", "package.json"))) result.electronAsar = join(resources, "app");
    result.packageJson = existsSync(join(path, "package.json"));
    result.bundle = ext === ".app" || existsSync(join(path, "Contents", "Info.plist"));
    return result;
  }
  const handle = await openFile(path, "r");
  try {
    const buffer = Buffer.alloc(16);
    const { bytesRead } = await handle.read(buffer, 0, 16, 0);
    if (bytesRead >= 4) result.magic = MAGIC.find(([, test]) => test(buffer))?.[0] ?? null;
  } finally {
    await handle.close();
  }
  return result;
}

async function listDirectory(path: string | null) {
  const target = resolve(path || homedir());
  const entries = await readdir(target, { withFileTypes: true });
  const items = entries
    .filter((e) => !e.name.startsWith("."))
    .map((e) => ({ name: e.name, path: join(target, e.name), dir: e.isDirectory() }))
    .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
  return { path: target, parent: dirname(target) === target ? null : dirname(target), items };
}

// ---------- HTTP server ----------
const token = randomBytes(24).toString("hex");
const allowedHosts = new Set([`${host}:${port}`, `localhost:${port}`, `127.0.0.1:${port}`]);
const mime: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
// Served before sign-in, so the sign-in page can render.
const PUBLIC_FILES = new Set(["login.html", "style.css", "icon.svg", "favicon.ico", "apple-touch-icon.png"]);

// Uploads land in their own folder each, keeping the original file name (REA uses it to tell formats apart).
async function saveUpload(req: IncomingMessage, name: string | null) {
  const safe = String(name ?? "").replace(/[/\\\0]/g, "_").replace(/^\.+/, "").slice(0, 200) || "upload";
  const size = Number(req.headers["content-length"]);
  if (Number.isFinite(size) && size > maxUpload) throw httpError(`File is larger than the ${Math.round(maxUpload / 1048576)} MB limit`, 413);
  const dir = join(dataDir, "uploads", `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`);
  await mkdir(dir, { recursive: true });
  const path = join(dir, safe);
  let received = 0;
  try {
    await pipeline(
      req,
      async function* (source: AsyncIterable<Buffer>) {
        for await (const chunk of source) {
          if ((received += chunk.length) > maxUpload) throw httpError(`File is larger than the ${Math.round(maxUpload / 1048576)} MB limit`, 413);
          yield chunk;
        }
      },
      createWriteStream(path),
    );
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
  return { path, name: safe, size: received };
}

function serverKey(provider: string): boolean {
  if (isCompatProvider(provider)) return Boolean(envKey(provider));
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

const LARGE_BODY = 200_000_000;
async function readBody(req: IncomingMessage, limit = 1_000_000): Promise<Body> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    if ((size += chunk.length) > limit) throw httpError("Request body too large", 413);
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  const parsed: unknown = text ? JSON.parse(text) : {};
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw httpError("Expected a JSON object", 400);
  return parsed as Body;
}

const server = createServer(async (req, res) => {
  // Locally, refuse DNS-rebinding requests addressed to another host name. A server is reached
  // through its own domain, and the password protects it instead.
  if (!remote && !allowedHosts.has(req.headers.host ?? "")) {
    res.writeHead(403).end("Forbidden host");
    return;
  }
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  try {
    // For hosting platforms' health checks; says nothing about what's analyzed.
    if (url.pathname === "/healthz") return sendJson(res, 200, { ok: true, rea: client?.state ?? "stopped" });
    if (auth && url.pathname === "/api/login" && req.method === "POST") {
      const { password } = await readBody(req);
      const result = auth.signIn(password, req);
      if (!result.ok) return sendJson(res, result.status, { error: result.error });
      res.setHeader("set-cookie", result.cookie);
      return sendJson(res, 200, { ok: true });
    }
    if (auth && url.pathname === "/api/logout" && req.method === "POST") {
      res.setHeader("set-cookie", auth.signOut(req));
      return sendJson(res, 200, { ok: true });
    }
    if (auth && !auth.signedIn(req)) {
      const file = url.pathname.slice(1);
      if (url.pathname.startsWith("/api/")) return sendJson(res, 401, { error: "Sign in first", signIn: true });
      if (url.pathname === "/" || url.pathname === "/index.html") return void res.writeHead(302, { location: "/login.html" }).end();
      if (!PUBLIC_FILES.has(file)) return void res.writeHead(404).end("Not found");
    }

    if (!url.pathname.startsWith("/api/")) {
      const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      const full = resolve(publicDir, file);
      if (!full.startsWith(publicDir + sep)) return void res.writeHead(404).end();
      let body = await readFile(full).catch(() => null);
      if (!body) return void res.writeHead(404).end("Not found");
      if (file === "index.html") {
        body = Buffer.from(body.toString("utf8").replace("__REA_GUI_TOKEN__", token).replace("__REA_GUI_MODE__", remote ? "server" : "local").replace("__REA_GUI_AUTH__", auth ? "password" : "none"));
      }
      // The page holds the API token: never let another site frame it or a cache keep it.
      res.writeHead(200, {
        "content-type": mime[extname(full)] ?? "application/octet-stream",
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
        "referrer-policy": "no-referrer",
        ...(file === "index.html" ? { "cache-control": "no-store" } : {}),
      });
      return void res.end(body);
    }

    // Every API request must carry the token embedded in the served page.
    const supplied = req.headers["x-rea-gui-token"] ?? url.searchParams.get("token");
    if (supplied !== token) return sendJson(res, 401, { error: "Missing or invalid token" });

    if (url.pathname === "/api/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
      });
      res.write(`event: status\ndata: ${JSON.stringify(statusSnapshot())}\n\n`);
      sseClients.add(res);
      const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 15000);
      req.on("close", () => {
        clearInterval(keepAlive);
        sseClients.delete(res);
      });
      return;
    }
    if (url.pathname === "/api/status") return sendJson(res, 200, { ...statusSnapshot(), stderr: client?.stderrTail ?? [] });
    if (url.pathname === "/api/session") return sendJson(res, 200, { session });
    if (url.pathname === "/api/tools") return sendJson(res, 200, { tools, instructions: client?.instructions ?? null });
    if (url.pathname === "/api/apps") return sendJson(res, 200, { apps: await listApplications() });
    if (url.pathname === "/api/icon") {
      const icon = appIcon(url.searchParams.get("app"));
      if (!icon) return void res.writeHead(404).end();
      res.writeHead(200, { "content-type": "image/png", "cache-control": "max-age=86400" });
      return void res.end(await readFile(icon));
    }
    if (url.pathname === "/api/upload" && req.method === "POST") {
      return sendJson(res, 201, await saveUpload(req, url.searchParams.get("name")));
    }
    if (url.pathname === "/api/detect") return sendJson(res, 200, await detectPath(url.searchParams.get("path")));
    if (url.pathname === "/api/fs") return sendJson(res, 200, await listDirectory(url.searchParams.get("path")));
    if (url.pathname === "/api/restart" && req.method === "POST") {
      startRea();
      return sendJson(res, 202, { ok: true });
    }
    if (url.pathname === "/api/call" && req.method === "POST") {
      if (client?.state !== "ready") return sendJson(res, 503, { error: "REA is not ready" });
      // Tool arguments can carry whole evidence records (e.g. a file inventory), so allow large bodies here.
      const { name, arguments: args, target } = await readBody(req, LARGE_BODY);
      const tool = tools.find((t) => t.name === name);
      if (!tool) return sendJson(res, 404, { error: `Unknown tool ${String(name)}` });
      return sendJson(res, 202, { callId: startCall(client, tool.name, (args ?? {}) as JsonObject, { target: str(target) }) });
    }
    const callMatch = url.pathname.match(/^\/api\/calls\/([0-9a-f]+-\d+)(\/cancel)?$/);
    if (callMatch) {
      const record = calls.get(callMatch[1] ?? "");
      if (!record) return sendJson(res, 404, { error: "Unknown call" });
      if (callMatch[2] && req.method === "POST") {
        record.cancel();
        return sendJson(res, 200, { ok: true });
      }
      const { cancel: _cancel, ...body } = record;
      return sendJson(res, 200, body);
    }
    // ---------- Saved analyses ----------
    if (url.pathname === "/api/analyses" && req.method === "GET") return sendJson(res, 200, { analyses: await analyses.list() });
    const analysisMatch = url.pathname.match(/^\/api\/analyses\/([^/]+)$/);
    if (analysisMatch) {
      const id = analysisMatch[1];
      if (!AnalysisStore.validId(id)) return sendJson(res, 400, { error: "Invalid analysis id" });
      if (req.method === "GET") {
        const snapshot = await analyses.get(id);
        return snapshot ? sendJson(res, 200, snapshot) : sendJson(res, 404, { error: "Analysis not found" });
      }
      if (req.method === "PUT") {
        // Full REA results can be large (JavaScript analyses especially).
        const snapshot = await readBody(req, LARGE_BODY);
        if (snapshot.id !== id || typeof snapshot.path !== "string" || !Array.isArray(snapshot.steps)) return sendJson(res, 400, { error: "Invalid analysis" });
        return sendJson(res, 200, await analyses.save({ ...snapshot, at: Number(snapshot.at) || Date.now() } as AnalysisSnapshot));
      }
      if (req.method === "DELETE") return sendJson(res, (await analyses.remove(id)) ? 200 : 404, { ok: true });
    }
    // ---------- Chat agent API ----------
    if (url.pathname === "/api/chat/config" && req.method === "GET") {
      return sendJson(res, 200, {
        agents: publicAgents(),
        providers: PROVIDERS.map((p) => ({ ...p, serverKey: serverKey(p.id) })),
        models: MODELS, // Anthropic's; other providers' come from /api/chat/models
        efforts: EFFORTS,
        defaultEffort: DEFAULT_EFFORT,
        serverKey: serverKey("anthropic"),
      });
    }
    // Other providers' catalogs change often, so the browser asks for them (with its key) instead of a fixed list.
    if (url.pathname === "/api/chat/models" && req.method === "POST") {
      const { provider, apiKey, refresh } = await readBody(req);
      if (typeof provider !== "string" || !isCompatProvider(provider)) return sendJson(res, 200, { models: MODELS });
      try {
        return sendJson(res, 200, { models: await listModels(provider, str(apiKey) || envKey(provider), { refresh: Boolean(refresh) }) });
      } catch (err) {
        return sendJson(res, 502, { error: `Couldn't load models: ${errorMessage(err)}` });
      }
    }
    if (url.pathname === "/api/chat/sessions" && req.method === "GET") {
      return sendJson(res, 200, { sessions: [...chats].map(([id, chat]) => chatSummary(id, chat)).reverse() });
    }
    if (url.pathname === "/api/chat/sessions" && req.method === "POST") {
      const body = await readBody(req);
      const providerId = str(body.provider) ?? "anthropic";
      const apiKey = str(body.apiKey) || undefined;
      const model = str(body.model);
      const provider = PROVIDERS.find((p) => p.id === providerId);
      if (!provider) return sendJson(res, 400, { error: `Unknown provider ${providerId}` });
      if (!apiKey && !serverKey(provider.id)) return sendJson(res, 400, { error: `An ${provider.keyLabel} is required` });
      const compat = isCompatProvider(provider.id) ? provider.id : null;
      let modelInfo: ListedModel | null = null;
      if (compat) {
        if (!model) return sendJson(res, 400, { error: `Pick a ${provider.label} model` });
        // Model details decide whether to ask for reasoning; chatting still works if the catalog is unreachable.
        modelInfo = (await listModels(compat, apiKey || envKey(compat)).catch((): ListedModel[] => [])).find((m) => m.id === model) ?? null;
      }
      const id = `chat-${bootId}-${++chatSeq}`;
      // A scoped chat (e.g. one analysis) carries fixed context; cap it so a page can't bloat every request.
      const scope = str(body.scope)?.slice(0, 2048) ?? null;
      const context = str(body.context);
      const log: ChatEvent[] = [];
      const streams = new Set<ServerResponse>();
      const options: SessionOptions = {
        apiKey,
        model,
        agent: str(body.agent),
        context: context?.slice(0, 20000),
        getMcpClient: () => client,
        // App chats are tied to one app: target tools open it first instead of reading another file.
        target: scope?.startsWith("app:") && scope !== "app:general" ? scope.slice(4) : undefined,
        callTool: (name, args, opts) => {
          if (!client) throw new Error("REA is not running");
          return broker.call(client, name, args, opts);
        },
        getMcpTools: () => tools,
        onEvent: (event) => recordChatEvent(chat, event),
      };
      const chat: Chat = {
        session: compat ? new CompletionsSession({ ...options, provider: compat, modelInfo }) : new AnthropicSession(options),
        log,
        streams,
        createdAt: Date.now(),
        scope,
      };
      chats.set(id, chat);
      return sendJson(res, 201, chatSummary(id, chat));
    }
    const chatMatch = url.pathname.match(/^\/api\/chat\/sessions\/([^/]+)(?:\/(stream|message|approve|abort))?$/);
    if (chatMatch) {
      const [, id = "", action] = chatMatch;
      const chat = chats.get(id);
      if (!chat) return sendJson(res, 404, { error: "Unknown chat session" });
      const sess = chat.session;
      if (action === "stream" && req.method === "GET") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        // A fresh connection (including EventSource's auto-reconnect) rebuilds the transcript from the log.
        res.write(`event: reset\ndata: ${JSON.stringify({ ...chatSummary(id, chat), events: chat.log })}\n\n`);
        chat.streams.add(res);
        const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 15000);
        req.on("close", () => {
          clearInterval(keepAlive);
          chat.streams.delete(res);
        });
        return;
      }
      if (action === "message" && req.method === "POST") {
        const body = await readBody(req);
        const message = str(body.message)?.trim();
        if (!message) return sendJson(res, 400, { error: "message is required" });
        if (sess.busy) return sendJson(res, 409, { error: "Wait for the current reply to finish, or stop it" });
        // The stream delivers the reply; run() reports its own errors as events.
        sess.run(message, { effort: str(body.effort) ?? DEFAULT_EFFORT }).catch(() => {});
        return sendJson(res, 202, { ok: true });
      }
      if (action === "approve" && req.method === "POST") {
        const { toolUseId, approved } = await readBody(req);
        if (!sess.approve(str(toolUseId) ?? "", approved)) return sendJson(res, 404, { error: "No pending approval for that tool call" });
        return sendJson(res, 200, { ok: true });
      }
      if (action === "abort" && req.method === "POST") {
        sess.abort();
        return sendJson(res, 200, { ok: true });
      }
      if (!action && req.method === "DELETE") {
        sess.abort();
        for (const r of chat.streams) r.end();
        chats.delete(id);
        return sendJson(res, 200, { ok: true });
      }
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (err) {
    const status = (err as { status?: unknown }).status;
    sendJson(res, typeof status === "number" ? status : 500, { error: errorMessage(err) });
  }
});

server.on("error", (err: NodeJS.ErrnoException) => {
  console.error(err.code === "EADDRINUSE" ? `Port ${port} is in use; pass --port N.` : err.message);
  process.exit(1);
});

server.listen(port, host, () => {
  const address = `http://${host === "127.0.0.1" ? "localhost" : host}:${port}/`;
  console.log(`REA GUI ${pkg.version} → ${address}`);
  console.log(`  REA: ${launch.label}`);
  if (!flag("no-open")) {
    const opener = ({ darwin: "open", win32: "explorer.exe" } as Record<string, string>)[platform()] ?? "xdg-open";
    spawn(opener, [address], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  }
  startRea();
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    client?.stop();
    process.exit(0);
  });
}
