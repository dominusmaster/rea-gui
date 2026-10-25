// REA GUI frontend. All target-derived text is rendered with textContent, never innerHTML.
import { isEvidence, renderEvidence, drillPanel, renderFacts } from "/evidence.js";
import { classify, KINDS, runAnalysis, restoreAnalysis, type Analysis } from "/analyze.js";
import { h, $, $opt, errorMessage, type CallRecord, type Child, type EvidenceContext, type FieldEvent, type JsonTree, type Props, type ReaData, type Tool } from "/dom.js";
const token = document.querySelector<HTMLMetaElement>('meta[name="rea-gui-token"]')?.content ?? "";
// "server": REA GUI runs on another machine, so files are uploaded rather than picked from this computer.
const serverMode = document.querySelector<HTMLMetaElement>('meta[name="rea-gui-mode"]')?.content === "server";
const passwordAuth = document.querySelector<HTMLMetaElement>('meta[name="rea-gui-auth"]')?.content === "password";
const main = $("#main");

/** The server's status event. */
interface Status {
  state: "starting" | "ready" | "failed" | "stopped";
  error: string | null;
  serverInfo: { name?: string; version?: string } | null;
  protocolVersion: string | null;
  toolCount: number;
  reaSession: string;
  launch: string;
  guiVersion: string;
}

/** What REA's binary_session says, as the server summarizes it. */
interface Session {
  open: boolean;
  target: { path: string; format?: string; kind?: string; architecture?: string; sha256?: string } | null;
  providers: { id: string; name: string; status: string; code: string | null; reason: string | null }[];
  binding: ReaData;
  availability: Record<string, { available: boolean; reason?: string; remediation?: string }>;
}

interface InstalledApp {
  name: string;
  path: string;
  kind: "desktop" | "electron";
  analyzePath: string;
}

/** A tool run kept in the sidebar's history. */
interface HistoryItem {
  callId: string;
  name: string;
  args: ReaData;
  at: number;
  state: string;
  app?: string | null;
}

const state: {
  status: Status | null;
  tools: Tool[];
  apps: InstalledApp[] | null;
  current: { callId: string; name: string; startedAt?: number; resultEl: HTMLElement; timer?: ReturnType<typeof setInterval>; onDone?: (record: CallRecord) => void } | null;
  progress: Map<string, ReaData>;
  history: HistoryItem[];
  pendingArgs: ReaData | null;
  reopenCall: string | null;
  autoRun: boolean;
  session: Session | null;
  hideUnavailable: boolean;
  analyses: Analysis[];
} = {
  status: null,
  tools: [],
  apps: null,
  current: null,
  progress: new Map(),
  history: JSON.parse(localStorage.getItem("rea-gui-history") ?? "[]"),
  pendingArgs: null,
  reopenCall: null,
  autoRun: false,
  session: null,
  hideUnavailable: localStorage.getItem("rea-gui-hide-unavailable") === "1",
  // Saved analyses come from the server; entries with a live `page` were opened in this tab.
  analyses: [],
};
const waiters = new Map();
// Evidence produced in this session, newest first: { id, label }.
const recentEvidence: { id: string; label: string }[] = [];
function rememberEvidence(ev: ReaData) {
  const id = ev.normalized_result?.parent_evidence_id ?? ev.evidence_id;
  if (recentEvidence.some((e) => e.id === id)) return;
  recentEvidence.unshift({ id, label: `${ev.subject?.name ?? "evidence"} · ${ev.normalized_result?.parent_operation ?? ev.operation}` });
  recentEvidence.splice(20);
}

// ---------- tiny DOM helper ----------
// replaceChildren would render null as the text "null".
const setMain = (...children: Child[]) => {
  const nodes: (Node | string)[] = [];
  const add = (c: Child): void => {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) c.forEach(add);
    else nodes.push(c instanceof Node ? c : String(c));
  };
  children.forEach(add);
  main.replaceChildren(...nodes);
  main.scrollTop = 0; // a new page starts at its top, not at the previous page's offset
};

// Server responses are JSON whose shape depends on the endpoint.
async function api(path: string, { method = "GET", body }: { method?: string; body?: unknown } = {}): Promise<ReaData> {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: { "x-rea-gui-token": token, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    setConnection("lost");
    throw new Error("Can't reach the REA GUI server. Check that it's still running.");
  }
  // Each server start issues a new token, so a 401 means the server restarted under this page,
  // or, on a password-protected server, that the sign-in expired.
  if (res.status === 401) {
    if ((await res.clone().json().catch(() => null))?.signIn) {
      location.href = "/login.html";
      throw new Error("Signed out. Sign in again to continue.");
    }
    setConnection("restarted");
    throw new Error("REA GUI restarted. Reload the page to continue.");
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

// ---------- status & events ----------
function renderStatus() {
  const s = state.status;
  const el = $("#status");
  el.className = `status ${connection === "ok" ? s?.state ?? "" : "stopped"}`;
  const text =
    connection === "lost"
      ? "Server not reachable"
      : connection === "restarted"
        ? "Server restarted: reload the page"
        : s?.state === "ready"
      ? `${s.serverInfo?.name ?? "REA"} ${s.serverInfo?.version ?? ""} · ${s.toolCount} tools`
      : s?.state === "starting"
        ? "Starting REA…"
        : s?.state === "failed" || s?.state === "stopped"
          ? `REA unavailable: ${s.error ?? "stopped"}`
          : "Connecting…";
  $("#status-text").textContent = text;
  el.title = s?.launch ? `Launch: ${s.launch}` : "";
  renderBanner();
}

// Explain a failed REA start in place, with the server's last error lines.
// ---------- connection to the REA GUI server ----------
// "ok", "lost" (server unreachable; retried until it's back) or "restarted" (new token: the page must reload).
let connection = "ok";
let connectionPoll: ReturnType<typeof setInterval> | undefined;
function setConnection(next: ReaData) {
  if (connection === next || connection === "restarted") return;
  connection = next;
  clearInterval(connectionPoll);
  if (next === "lost") connectionPoll = setInterval(checkConnection, 3000);
  renderStatus();
}
async function checkConnection(): Promise<void> {
  try {
    const res = await fetch("/api/status", { headers: { "x-rea-gui-token": token } });
    if (res.status === 401 && (await res.json().catch(() => null))?.signIn) return void (location.href = "/login.html");
    setConnection(res.status === 401 ? "restarted" : "ok");
  } catch {
    setConnection("lost");
  }
}

async function renderBanner() {
  const banner = $("#banner");
  if (connection !== "ok") {
    banner.replaceChildren(
      ...(connection === "lost"
        ? [
            h("strong", { text: "Can't reach the REA GUI server. " }),
            h("span", { text: serverMode ? "It may have stopped or be restarting. This page reconnects by itself." : "It may have stopped. Start it again from the rea-gui folder with npm start; this page reconnects by itself." }),
          ]
        : [
            h("strong", { text: "REA GUI restarted. " }),
            h("span", { text: "Reload this page to reconnect. Saved analyses are kept." }),
            h("div", { class: "actions" }, h("button", { class: "primary", text: "Reload page", onclick: () => location.reload() })),
          ]),
    );
    return banner.classList.remove("hidden");
  }
  const failed = state.status?.state === "failed" || state.status?.state === "stopped";
  if (!failed) return banner.classList.add("hidden");
  let stderr = [];
  try {
    stderr = (await api("/api/status")).stderr ?? [];
  } catch {}
  banner.replaceChildren(
    h("strong", { text: "REA could not start. " }),
    h("span", { text: stderr.find((line: string) => /\b(Error|error)\b[:\s]|EACCES|ENOENT|not supported|unsupported/.test(line))?.trim() ?? state.status?.error ?? "" }),
    h("pre", { text: stderr.slice(-12).join("\n") || "No output from REA." }),
    h(
      "div",
      { class: "actions" },
      h("button", { class: "primary", text: "Restart REA", onclick: () => api("/api/restart", { method: "POST" }) }),
      h("span", {
        class: "muted",
        text: `Launch: ${state.status?.launch ?? "unknown"}. Set REA_BIN to REA's scripts/rea.mjs and REA_NODE to Node 22.19+, 24.11+ or 26+ if needed, then relaunch rea-gui.`,
      }),
    ),
  );
  banner.classList.remove("hidden");
}

const logEl = $("#log");
function appendLog(line: string) {
  logEl.textContent += `${line}\n`;
  if (logEl.textContent.length > 200_000) logEl.textContent = logEl.textContent.slice(-150_000);
  logEl.scrollTop = logEl.scrollHeight;
}

// Resolves once REA's status (with the current run's ID) and, if REA is up, its tools are known.
let statusKnown = () => {};
const statusReady = new Promise<void>((resolve) => (statusKnown = resolve));

function connectEvents() {
  const events = new EventSource(`/api/events?token=${token}`);
  events.addEventListener("open", () => setConnection("ok"));
  // EventSource retries on its own while the server is down, but gives up on a 401 (new token).
  events.addEventListener("error", () => checkConnection());
  events.addEventListener("status", async (e) => {
    const previous = state.status?.state;
    const status: Status = JSON.parse(e.data);
    state.status = status;
    renderStatus();
    if (status.state === "ready" && (previous !== "ready" || state.tools.length === 0)) {
      await loadTools();
    }
    if (status.state !== "starting") statusKnown();
  });
  events.addEventListener("stderr", (e) => appendLog(JSON.parse(e.data)));
  events.addEventListener("log", (e) => {
    const p = JSON.parse(e.data);
    appendLog(`[${p.level}] ${typeof p.data === "string" ? p.data : JSON.stringify(p.data)}`);
  });
  events.addEventListener("progress", (e) => {
    const p = JSON.parse(e.data);
    state.progress.set(p.callId, p);
    progressListeners.get(p.callId)?.(p);
    if (state.current?.callId === p.callId) updateProgress(p);
  });
  events.addEventListener("session", (e) => {
    state.session = JSON.parse(e.data);
    renderSession();
  });
  events.addEventListener("call-finished", (e) => {
    const { callId, state: callState } = JSON.parse(e.data);
    waiters.get(callId)?.();
    const entry = state.history.find((item: ReaData) => item.callId === callId);
    if (entry) {
      entry.state = callState;
      saveHistory();
    }
    if (state.current?.callId === callId) showCall(callId);
  });
}

async function loadTools() {
  const [{ tools }, { session }] = await Promise.all([api("/api/tools"), api("/api/session")]);
  if (session) {
    state.session = session;
    renderSession();
  }
  state.tools = tools.sort((a: ReaData, b: ReaData) => a.name.localeCompare(b.name));
  renderToolList();
  // Pages drawn before the tool list arrived need redrawing.
  route(true);
}

// Run a tool without adding it to history. done resolves with the finished call record.
const progressListeners = new Map();
// target: the app this call is about; the server opens it first if REA has another file open.
async function startCall(name: string, args: ReaData, onProgress?: (progress: ReaData) => void, target?: string): Promise<{ callId: string; done: Promise<CallRecord> }> {
  const { callId } = await api("/api/call", { method: "POST", body: { name, arguments: args, target } });
  if (onProgress) progressListeners.set(callId, onProgress);
  const done = new Promise<void>((resolve) => {
    waiters.set(callId, resolve);
    // The call may already have finished before the waiter was registered.
    api(`/api/calls/${callId}`).then((r) => r.state !== "running" && resolve()).catch(() => {});
  }).then(() => {
    waiters.delete(callId);
    progressListeners.delete(callId);
    return api(`/api/calls/${callId}`);
  });
  return { callId, done };
}
const callAndWait = async (name: string, args: ReaData) => (await startCall(name, args)).done;

// "target_required" only means nothing is open yet; the guided flows open the target themselves.
const availabilityOf = (name: string) => {
  const a = state.session?.availability?.[name] ?? null;
  return a?.reason === "target_required" ? { ...a, available: true } : a;
};
const toolExists = (name: string) => state.tools.some((t) => t.name === name);
const usable = (name: string) => toolExists(name) && availabilityOf(name)?.available !== false;

function renderSession() {
  const bar = $("#target");
  // The active target only matters when driving individual tools.
  const target = location.hash.startsWith("#/tool/") ? state.session?.target : null;
  if (target) {
    bar.classList.remove("hidden");
    $("#target-text").textContent = `${target.path.split("/").pop()} · ${target.format}${target.architecture ? ` ${target.architecture}` : ""}`;
    bar.title = target.path;
  } else {
    bar.classList.add("hidden");
  }
  renderToolList();
  syncToolChat();
  if (!location.hash.startsWith("#/tool/")) renderReadiness();
}

// Suggested follow-ups once a target is open, filtered by what this machine can run.
const NEXT_STEPS: [string, ReaData | ((target: ReaData) => ReaData), (target: ReaData) => boolean][] = [
  ["inspect_macho", { detail: "summary" }, (t: ReaData) => /mach-o/.test(t.format)],
  ["inspect_signature", {}, (t: ReaData) => /mach-o/.test(t.format)],
  ["inspect_electron_fuses", (t: ReaData) => ({ path: t.path }), (t: ReaData) => /mach-o|pe|elf/.test(t.format)],
  ["list_architectures", {}, (t: ReaData) => /mach-o/.test(t.format)],
  ["inspect_artifact", { detail: "summary" }, () => true],
  ["binary_overview", {}, () => true],
  ["inspect_managed_artifact", { detail: "summary" }, (t: ReaData) => /pe/.test(t.format)],
  ["close_binary", {}, () => true],
];

function nextStepButtons(target: ReaData) {
  const steps = NEXT_STEPS.filter(([name, , when]) => usable(name) && when(target));
  if (!steps.length) return null;
  return h(
    "div",
    { class: "explore" },
    h("div", { class: "section-label", text: `Next steps for ${target.path.split("/").pop()}` }),
    h("div", { class: "chips" }, ...steps.map(([name, args]) => h("button", { class: "ghost small", text: name, onclick: () => runQuick(name, typeof args === "function" ? args(target) : args) }))),
  );
}

// ---------- sidebar ----------
// The sidebar shows what applies to where you are. The full catalogue lives on the Tool library page.
// Domain groups for the library, matched in order against tool names.
const GROUPS: [string, RegExp][] = [
  ["Sessions & targets", /^(open_binary|close_binary|binary_session|binary_overview|inspect_desktop_application)$/],
  ["Android & devices", /adb|android|apk|jeb|dart|flutter|harmony/],
  ["Web & browser", /web|browser/],
  ["JavaScript & Electron", /javascript|electron|bundle|source_to/],
  [".NET managed code", /managed/],
  ["Dynamic & debugging", /frida|gdb|rizin_debug|cutter|process_|observe_native|capture_native/],
  ["Networks & signals", /packet|pcap|signal/],
  ["Files & formats", /artifact|plist|keyed_archive|asset_catalog|interface_builder|pe_resources|go_binary|rust_binary|wasm|evm|sqlite|firmware|crash|model|gpu|desktop|macho|signature|architectures|dylib/],
  ["Evidence & reconstruction", /evidence|unknown|reconstruction|analysis_view|compare|correlate|changed|navigation|ledger|coverage|project_|verify/],
  ["Native analysis", /./],
];

// Static tools that inspect one app of each kind, in the order they're usually useful.
// Live/runtime capture, evidence plumbing and two-input comparisons stay in the Tool library.
const APP_TOOLS: Record<string, string[]> = {
  electron: ["analyze_javascript_application", "inspect_electron_fuses", "inspect_signature", "inspect_macho", "list_architectures", "inspect_plist", "inspect_artifact", "extract_artifact", "recover_javascript_sources"],
  "mac-app": ["inspect_signature", "inspect_macho", "list_architectures", "trace_dylib_resolution", "inspect_plist", "inspect_asset_catalog", "decode_interface_builder", "list_strings", "inspect_artifact", "extract_artifact"],
  "mach-o": ["inspect_signature", "inspect_macho", "list_architectures", "trace_dylib_resolution", "inspect_binary_layout", "list_strings", "binary_overview"],
  android: ["inspect_android_package", "decode_android_resources", "search_android_classes", "identify_flutter_build", "inspect_dart_aot", "inspect_artifact", "extract_artifact"],
  ios: ["inspect_artifact", "extract_artifact", "inspect_plist", "inspect_asset_catalog", "decode_interface_builder"],
  js: ["analyze_javascript_application", "recover_javascript_sources"],
  windows: ["inspect_pe_resources", "inspect_managed_artifact", "inspect_managed_members", "inspect_electron_fuses", "inspect_binary_layout", "inspect_go_binary", "inspect_rust_binary"],
  elf: ["inspect_binary_layout", "inspect_go_binary", "inspect_rust_binary", "inspect_electron_fuses", "list_strings"],
  wasm: ["inspect_wasm_artifact"],
  sqlite: ["inspect_sqlite_database"],
  archive: ["inspect_artifact", "extract_artifact"],
};

// "inspect_electron_fuses" → "Inspect electron fuses"; the raw name stays in the tooltip and search.
const toolLabel = (name: string) => name.charAt(0).toUpperCase() + name.slice(1).replace(/_/g, " ");
const toolBlocked = (name: string) => {
  const a = availabilityOf(name);
  return a?.available === false && !a.reason?.startsWith("target_") ? a : null;
};

// The app the current page is about: an analysis, or the file open in REA on a tool page.
function currentApp() {
  const analysisId = location.hash.match(/^#\/analysis\/(.+)$/)?.[1];
  if (analysisId) {
    const a = state.analyses.find((x) => x.id === analysisId);
    return a ? { key: appKeyFor(a.path), name: a.name, kind: a.kind, analysisId: a.id } : null;
  }
  const target = state.session?.target;
  if (!location.hash.startsWith("#/tool/") || !target) return null;
  const key = appKeyFor(target.path);
  const a = latestAnalysisFor(key);
  const kind = a?.kind ?? (/\.app$/.test(key) ? "mac-app" : /apk/.test(target.format ?? "") ? "android" : /ipa/.test(target.format ?? "") ? "ios" : /mach-o/.test(target.format ?? "") ? "mach-o" : /^pe/.test(target.format ?? "") ? "windows" : /elf/.test(target.format ?? "") ? "elf" : "archive");
  return { key, name: a?.name ?? fileName(key).replace(/\.app$/, ""), kind, analysisId: a?.id };
}

function renderToolList() {
  const count = $opt("#tool-count");
  if (count) count.textContent = state.tools.length ? String(state.tools.length) : "";
  $("#nav-home").classList.toggle("active", ["", "#/", "#"].includes(location.hash));
  $("#nav-tools").classList.toggle("active", location.hash === "#/tools");
  const chatNav = document.querySelector<HTMLElement>("#nav-chat");
  if (chatNav && !chatNav.dataset.wired) {
    chatNav.dataset.wired = "1";
    chatNav.addEventListener("click", () => (location.hash = "#/chat"));
  }
  renderAppContext();
  if (location.hash === "#/tools") renderLibraryList();
}

// Sidebar section for the app in view: its overview, the tools that fit it, and its recent runs.
function renderAppContext() {
  const el = $("#app-context");
  const app = currentApp();
  if (!app || !state.tools.length) return el.replaceChildren();
  const tools = (APP_TOOLS[app.kind] ?? APP_TOOLS.archive ?? []).flatMap((name: string) => state.tools.find((t) => t.name === name) ?? []);
  const ready = tools.filter((t: ReaData) => !toolBlocked(t.name));
  const setup = tools.filter((t: ReaData) => toolBlocked(t.name));
  const runs = state.history.filter((r: ReaData) => r.app === app.key).slice(0, 5);
  const toolButton = (t: ReaData) =>
    h(
      "button",
      {
        class: `nav-item tool-item ${location.hash === `#/tool/${t.name}` ? "active" : ""} ${toolBlocked(t.name) ? "unavailable" : ""}`,
        title: toolBlocked(t.name) ? `${t.name}\nNeeds setup: ${toolBlocked(t.name)?.remediation ?? toolBlocked(t.name)?.reason}` : t.name,
        // Tool pages act on REA's open file, so open this app first when it isn't the open one.
        onclick: () => openToolForApp(t.name, app),
      },
      h("span", { class: "grow", text: toolLabel(t.name) }),
    );
  el.replaceChildren(
    h(
      "div",
      { class: "app-context" },
      h("div", { class: "section-label app-context-label", title: app.key }, h("span", { class: "grow", text: app.name }), h("span", { class: "badge", text: KINDS[app.kind]?.label ?? "File" })),
      app.analysisId
        ? h("button", { class: `nav-item ${location.hash === `#/analysis/${app.analysisId}` ? "active" : ""}`, onclick: () => (location.hash = `#/analysis/${app.analysisId}`) }, h("span", { text: "Overview" }))
        : h("button", { class: "nav-item", onclick: () => analyzePath(app.key) }, h("span", { text: "Run guided analysis" })),
      h(
        "div",
        { class: "app-context-tools" },
        ...ready.map(toolButton),
        setup.length ? h("details", { class: "app-context-setup" }, h("summary", { text: `${setup.length} more need setup` }), ...setup.map(toolButton)) : null,
      ),
      runs.length ? h("div", { class: "section-label", text: "Recent runs" }) : null,
      ...runs.map(historyButton),
    ),
  );
}

async function openToolForApp(name: string, app: ReaData) {
  const tool = state.tools.find((t) => t.name === name);
  const props = tool?.inputSchema?.properties ?? {};
  // Fill this app's path into the tool's path field; tools without one act on REA's open file.
  const pathField = ["path", "input_path", "artifact_path", "bundle_path", "app_path"].find((k) => props[k]?.type === "string");
  // JavaScript tools read an Electron app's bundled code, not the .app itself.
  const jsTool = /javascript/.test(name) && app.kind === "electron" && app.key.endsWith(".app");
  if (pathField) state.pendingArgs = { [pathField]: jsTool ? `${app.key}/Contents/Resources/app.asar` : app.key };
  else if (!(state.session?.target && appKeyFor(state.session.target.path) === app.key)) await callAndWait("open_binary", { path: app.key }).catch(() => {});
  location.hash = `#/tool/${name}`;
  route(true);
}

const openGroups = new Set(JSON.parse(localStorage.getItem("rea-gui-open-groups") ?? "[]"));

// ---------- tool library page ----------
function renderLibrary() {
  const search = h("input", { type: "search", id: "tool-search", placeholder: "Search by name or description", "aria-label": "Search tools", autocomplete: "off" });
  const readyOnly = h("input", { type: "checkbox", role: "switch", id: "hide-unavailable", checked: state.hideUnavailable });
  search.addEventListener("input", renderLibraryList);
  readyOnly.addEventListener("change", () => {
    state.hideUnavailable = readyOnly.checked;
    localStorage.setItem("rea-gui-hide-unavailable", readyOnly.checked ? "1" : "0");
    renderLibraryList();
  });
  setMain(
    h("h1", { text: "Tool library" }),
    h("p", { class: "lede", text: "Every tool REA offers, for running one directly with your own arguments. For a specific app, its tools also appear in the sidebar while you're on it." }),
    h(
      "div",
      { class: "library-layout" },
      h(
        "div",
        { class: "library-main" },
        h("div", { class: "library-controls" }, h("div", { class: "tool-search" }, icon(["M21 21l-4.3-4.3", "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z"]), search), h("label", { class: "toggle" }, readyOnly, h("span", { text: "Only tools that work here" }))),
        h("div", { id: "tool-list", class: "library-list" }),
      ),
      h("aside", { class: "library-side" }, h("div", { class: "card-title", text: "Recent tool runs" }), h("div", { id: "history-list" })),
    ),
  );
  renderLibraryList();
  renderHistory();
}

function renderLibraryList() {
  const list = $opt("#tool-list");
  if (!list) return;
  const query = $<HTMLInputElement>("#tool-search").value.trim().toLowerCase();
  const matches = state.tools
    .filter((t) => !(state.hideUnavailable && toolBlocked(t.name)))
    .filter((t) => !query || t.name.includes(query) || toolLabel(t.name).toLowerCase().includes(query) || (t.description ?? "").toLowerCase().includes(query));
  const grouped = new Map();
  for (const tool of matches) {
    const group = GROUPS.find(([, re]) => re.test(tool.name))?.[0] ?? "Other";
    if (!grouped.has(group)) grouped.set(group, []);
    grouped.get(group).push(tool);
  }
  list.replaceChildren(
    ...GROUPS.filter(([g]) => grouped.has(g)).map(([group]) => {
      const items = grouped.get(group);
      const ready = items.filter((t: ReaData) => !toolBlocked(t.name)).length;
      const details = h(
        "details",
        { class: "library-group", open: Boolean(query) || openGroups.has(group) },
        h("summary", {}, h("span", { class: "grow", text: group }), h("span", { class: "muted small", text: ready === items.length ? `${items.length} tools` : `${ready} of ${items.length} ready` })),
        h(
          "div",
          { class: "library-rows" },
          ...items.map((t: ReaData) => {
            const blocked = toolBlocked(t.name);
            return h(
              "button",
              { class: `library-row ${blocked ? "unavailable" : ""}`, title: blocked ? `Needs setup: ${blocked.remediation ?? blocked.reason}` : "", onclick: () => (location.hash = `#/tool/${t.name}`) },
              h("span", { class: "library-row-name" }, h("span", { text: toolLabel(t.name) }), h("code", { text: t.name })),
              h("span", { class: "library-row-desc", text: (t.description ?? "").split(/(?<=\.)\s/)[0] }),
              blocked ? h("span", { class: "tool-setup", text: "Needs setup" }) : null,
            );
          }),
        ),
      );
      details.addEventListener("toggle", () => {
        if (query) return;
        if (details.open) openGroups.add(group);
        else openGroups.delete(group);
        localStorage.setItem("rea-gui-open-groups", JSON.stringify([...openGroups]));
      });
      return details;
    }),
  );
  if (!matches.length) list.append(h("div", { class: "empty", text: state.tools.length ? "No tools match." : "Waiting for REA…" }));
}

function saveHistory() {
  state.history = state.history.slice(0, 30);
  localStorage.setItem("rea-gui-history", JSON.stringify(state.history));
  renderHistory();
  renderAppContext();
}

function historyButton(item: ReaData) {
  const runIcon: Record<string, string> = { running: "◌", done: "✓", error: "✕" };
  const target = Object.values(item.args ?? {}).find((v) => typeof v === "string") ?? "";
  return h(
    "button",
    {
      class: "nav-item history-item",
      title: `${item.name}\n${JSON.stringify(item.args, null, 2)}`,
      onclick: () => {
        state.pendingArgs = item.args;
        state.reopenCall = item.callId;
        location.hash = `#/tool/${item.name}`;
        route(true);
      },
    },
    h("span", { class: `state ${item.state}`, text: runIcon[item.state] ?? "•" }),
    h("span", { class: "grow", text: toolLabel(item.name) }),
    h("span", { class: "type", text: target.split("/").filter(Boolean).slice(-1)[0] ?? "" }),
  );
}

function renderHistory() {
  const list = $opt("#history-list");
  if (!list) return;
  list.replaceChildren(...(state.history.length ? state.history.map(historyButton) : [h("div", { class: "empty", text: "No tool runs yet." })]));
}

// ---------- routing ----------
let lastRoute: string | null = null;
function route(force = false) {
  const hash = location.hash || "#/";
  if (hash === lastRoute && !force) return;
  lastRoute = hash;
  renderToolList();
  renderSession();
  renderAnalysisList();
  // Chat nav highlight
  const chatNav = document.querySelector<HTMLElement>("#nav-chat");
  if (chatNav) chatNav.classList.toggle("active", hash === "#/chat");
  if (hash === "#/chat") return renderChat();
  if (hash === "#/tools") return renderLibrary();
  const analysisMatch = hash.match(/^#\/analysis\/(.+)$/);
  if (analysisMatch) return renderAnalysisPage(analysisMatch[1] ?? "");
  const toolMatch = hash.match(/^#\/tool\/(.+)$/);
  if (toolMatch) {
    const tool = state.tools.find((t) => t.name === decodeURIComponent(toolMatch[1] ?? ""));
    if (tool) return renderTool(tool);
    if (!state.tools.length) return main.replaceChildren(h("div", { class: "empty", text: "Waiting for REA to start…" }));
  }
  renderHome();
}

// ---------- home & guided analysis ----------
function runQuick(name: string, args: ReaData) {
  state.pendingArgs = args;
  state.autoRun = true;
  location.hash = `#/tool/${name}`;
  route(true);
}

const iconUrl = (path: string) => `/api/icon?token=${token}&app=${encodeURIComponent(path)}`;
const analysisDeps = {
  h,
  startCall,
  cancelCall: (callId: string) => api(`/api/calls/${callId}/cancel`, { method: "POST" }).catch(() => {}),
  renderResult,
  evidenceCtx,
  toolExists,
  availabilityOf,
  iconUrl,
  onChange: (analysis: ReaData) => saveAnalysis(analysis),
  rerun: (path: string) => analyzePath(path),
  remove: (analysis: ReaData) => removeAnalysis(analysis),
  reaSession: () => state.status?.reaSession ?? null,
};

// ---------- per-app chat ----------
// One chat panel per app, shared by its analysis page and every tool page while that app is open
// in REA. The panel element is reused, so the conversation survives switching pages; "New chat"
// starts another and History switches between them. Without an open app the panel is a general REA chat.
interface AppChat {
  key: string;
  chatId: string | null;
  es: EventSource | null;
  busy: boolean;
  panel: HTMLElement;
}
const appChats = new Map<string, AppChat>(); // app key → its chat panel
const savedChatIds = JSON.parse(sessionStorage.getItem("rea-app-chats") ?? "{}"); // app key → active chat id

// Files inside a bundle belong to the bundle: ".../Ghostty.app/Contents/MacOS/ghostty" → ".../Ghostty.app".
function appKeyFor(path: string) {
  if (!path) return "general";
  return path.match(/^(.*?\.(?:app|ipa|apk|asar))(?:\/|$)/i)?.[1] ?? path;
}

function latestAnalysisFor(key: string) {
  return state.analyses.find((a) => appKeyFor(a.path) === key);
}

function appChatContext(key: string) {
  if (key === "general") {
    return "## This conversation\nNo app is open in REA GUI yet. Help the user pick and analyze one; any app or binary on this computer is in scope.";
  }
  const analysis = latestAnalysisFor(key);
  const name = analysis?.name ?? fileName(key);
  const lines = [
    "## This conversation",
    "The user is working on one app in REA GUI, moving between its analysis and individual REA tools, and asks about it here.",
    `- Name: ${name}`,
    analysis ? `- Kind: ${KINDS[analysis.kind]?.label ?? analysis.kind}` : null,
    `- Path: ${key}`,
    "",
    `Stay on this app. Answer only questions about ${name}, and point REA tools at this path or files inside it. If the user asks about anything else, say this chat is for ${name} and suggest the Chat page in the sidebar.`,
  ].filter((l) => l !== null);
  if (analysis?.results?.length) {
    lines.push("", "## Results of REA GUI's guided analysis", analysis.state === "running" ? "(The analysis was still running, so this may be incomplete.)" : "");
    for (const r of analysis.results) {
      lines.push(`### ${r.check}: ${r.headline ?? ""}`);
      for (const f of r.findings) lines.push(`- ${f}`);
      for (const [k, v] of r.facts) lines.push(`- ${k}: ${v}`);
    }
  }
  return lines.join("\n");
}

const fileName = (path: string): string => path.replace(/\/+$/, "").split("/").pop() ?? path;
const SUGGESTIONS: Record<string, string[]> = {
  general: ["Which of my apps are built with Electron?", "What can REA do without extra setup?"],
  electron: ["Summarize the security risks", "What do the exposed APIs let web pages do?", "Which IPC channels look sensitive?"],
  "mac-app": ["What can this app access?", "Which libraries does it link?", "Is anything unusual about its signature?"],
  android: ["What permissions does it ask for?", "Is it a Flutter app?", "Which native libraries does it ship?"],
  ios: ["What frameworks does it bundle?", "Is it signed?"],
};

const relTime = (t: ReaData) => {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
};

const icon = (paths: ReaData) => {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  for (const d of paths) {
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("d", d);
    svg.append(p);
  }
  return svg;
};

function appChat(key: string) {
  const existing = appChats.get(key);
  if (existing) return existing.panel;
  const general = key === "general";
  const name = general ? "REA" : latestAnalysisFor(key)?.name ?? fileName(key).replace(/\.app$/, "");
  const scope = `app:${key}`;
  const c: AppChat = { key, chatId: null, es: null, busy: false, panel: null as unknown as HTMLElement };

  const messages = h("div", { class: "chat-messages" });
  const body = h("div", { class: "chat-body" }, messages);
  const history = h("div", { class: "app-chat-history hidden" });
  const prompt = h("textarea", { class: "chat-prompt", rows: 2, placeholder: general ? "Ask REA anything…" : `Ask about ${name}…`, "aria-label": general ? "Ask REA" : `Ask about ${name}` });
  const send = h("button", { class: "primary small", type: "button", text: "Send" });
  const keyRow = h("div", { class: "analysis-chat-key hidden" });
  const status = h("p", { class: "chat-error-text hidden", role: "alert" });
  const historyButton = h("button", { class: "ghost icon-button", type: "button", title: "Chat history", "aria-label": "Chat history", "aria-pressed": "false" }, icon(["M3 12a9 9 0 1 0 3-6.7L3 8", "M3 3v5h5", "M12 7v5l3 2"]));
  const newButton = h("button", { class: "ghost icon-button", type: "button", title: "New chat", "aria-label": "New chat" }, icon(["M12 5v14", "M5 12h14"]));

  const setBusy = (value: ReaData) => {
    c.busy = value;
    send.textContent = value ? "Stop" : "Send";
    send.classList.toggle("primary", !value);
    send.classList.toggle("danger", value);
  };
  const remember = () => {
    if (c.chatId) savedChatIds[key] = c.chatId;
    else delete savedChatIds[key];
    sessionStorage.setItem("rea-app-chats", JSON.stringify(savedChatIds));
  };
  const showEmpty = () => {
    const kind = general ? "general" : latestAnalysisFor(key)?.kind;
    messages.replaceChildren(
      h(
        "div",
        { class: "analysis-chat-empty" },
        h("p", { class: "muted", text: general ? "Open a file in REA, or ask about any app on this computer. The assistant runs REA tools and asks before anything that changes state." : `Questions here stay on ${name}. The same chat follows you across this app's analysis and tool pages.` }),
        h("div", { class: "chips" }, ...(SUGGESTIONS[kind ?? "mac-app"] ?? SUGGESTIONS["mac-app"] ?? []).map((q: string) => h("button", { class: "ghost small", type: "button", text: q, onclick: () => ((prompt.value = q), submit()) }))),
      ),
    );
  };

  function connect(id: string | null) {
    c.es?.close();
    c.chatId = id;
    remember();
    if (!id) {
      setBusy(false);
      return showEmpty();
    }
    const es = new EventSource(`/api/chat/sessions/${encodeURIComponent(id)}/stream?token=${token}`);
    c.es = es;
    let view: ((event: ReaData) => void) | null = null;
    es.addEventListener("reset", (e) => {
      const data = JSON.parse(e.data);
      messages.replaceChildren();
      view = chatRenderer(messages, id, setBusy);
      for (const ev of data.events) view(ev);
      if (!data.events.length) showEmpty();
      setBusy(data.busy);
      body.scrollTop = body.scrollHeight;
    });
    es.addEventListener("chat", (e) => view?.(JSON.parse(e.data)));
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED || c.es !== es) return;
      // The session is gone (server restarted): start fresh instead of reconnecting forever.
      api("/api/chat/sessions").then(({ sessions }) => !sessions.some((s: ReaData) => s.id === id) && c.chatId === id && connect(null)).catch(() => {});
    };
  }

  const showKeyField = () => {
    const provider = chatProvider();
    const input = h("input", { type: "password", placeholder: provider.keyPlaceholder, autocomplete: "off", "aria-label": provider.keyLabel, value: chatKey() });
    input.addEventListener("change", () => setChatKey(input.value));
    keyRow.replaceChildren(
      h("label", { class: "field-label", text: provider.keyLabel }),
      h("p", { class: "muted small" }, "Saved in this browser and shared with every chat. To switch provider or model, open ", h("a", { href: "#/chat", text: "Chat settings" }), "."),
      input,
    );
    keyRow.classList.remove("hidden");
    input.focus();
  };
  const fail = (text: string) => {
    status.textContent = text;
    status.classList.remove("hidden");
  };

  async function submit() {
    if (c.busy) {
      if (c.chatId) api(`/api/chat/sessions/${encodeURIComponent(c.chatId ?? "")}/abort`, { method: "POST" }).catch(() => {});
      return;
    }
    const text = prompt.value.trim();
    if (!text) return prompt.focus();
    status.classList.add("hidden");
    if (!chatState.config) await loadChatConfig();
    if (!chatState.config) return fail(`Chat isn't available: ${chatState.configError ?? "unknown error"}`);
    if (!hasChatKey()) {
      showKeyField();
      return fail(`Add your ${chatProvider().keyLabel} to ask questions.`);
    }
    if (!chatModel()) await loadModels();
    const problem = chatSetupProblem();
    if (problem) return fail(problem);
    try {
      if (!c.chatId) {
        // REA tools are needed here, so always use the REA assistant.
        const agent = chatState.config.agents.find((a: ReaData) => a.usesRea)?.id ?? chatState.agent;
        const sess = await api("/api/chat/sessions", { method: "POST", body: newChatBody({ agent, context: appChatContext(key), scope }) });
        keyRow.classList.add("hidden");
        connect(sess.id);
      }
      prompt.value = "";
      await api(`/api/chat/sessions/${encodeURIComponent(c.chatId ?? "")}/message`, { method: "POST", body: { message: text, effort: chatState.effort } });
    } catch (err) {
      fail(errorMessage(err));
    }
  }

  async function toggleHistory(open = history.classList.contains("hidden")) {
    history.classList.toggle("hidden", !open);
    body.classList.toggle("hidden", open);
    historyButton.setAttribute("aria-pressed", String(open));
    historyButton.classList.toggle("active", open);
    if (!open) return;
    history.replaceChildren(h("p", { class: "muted small", text: "Loading…" }));
    let sessions = [];
    try {
      sessions = (await api("/api/chat/sessions")).sessions.filter((s: ReaData) => s.scope === scope);
    } catch (err) {
      return history.replaceChildren(h("p", { class: "chat-error-text", text: errorMessage(err) }));
    }
    history.replaceChildren(
      h("div", { class: "app-chat-history-head" }, h("span", { text: general ? "Earlier chats" : `Earlier chats about ${name}` }), h("span", { class: "muted small", text: String(sessions.length) })),
      ...(sessions.length
        ? sessions.map((s: ReaData) =>
            h(
              "button",
              {
                class: `app-chat-history-item ${s.id === c.chatId ? "active" : ""}`,
                type: "button",
                onclick: () => {
                  connect(s.id);
                  toggleHistory(false);
                },
              },
              h("span", { class: "grow", text: s.title ?? "Untitled chat" }),
              h("span", { class: "muted small", text: s.busy ? "Running" : relTime(s.createdAt) }),
            ),
          )
        : [h("p", { class: "muted small", text: "No earlier chats yet. They're kept until REA GUI restarts." })]),
    );
  }

  send.addEventListener("click", submit);
  prompt.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  });
  historyButton.addEventListener("click", () => toggleHistory());
  newButton.addEventListener("click", () => {
    toggleHistory(false);
    connect(null);
    prompt.focus();
  });

  c.panel = h(
    "aside",
    { class: "analysis-chat app-chat", "aria-label": general ? "Chat with REA" : `Chat about ${name}` },
    h(
      "div",
      { class: "analysis-chat-head" },
      h("div", { class: "grow" }, h("div", { class: "analysis-chat-title", text: general ? "Ask REA" : `Ask about ${name}` }), h("div", { class: "muted small", text: general ? "No app open" : "Same chat on every page for this app" })),
      historyButton,
      newButton,
      h("button", { class: "ghost icon-button analysis-chat-close", type: "button", "aria-label": "Close chat", title: "Close chat", onclick: () => c.panel.closest(".chat-shell")?.classList.remove("chat-open") }, icon(["M18 6 6 18", "m6 6 12 12"])),
    ),
    history,
    body,
    keyRow,
    status,
    h("div", { class: "chat-composer" }, prompt, h("div", { class: "chat-composer-bar" }, h("span", { class: "spacer" }), send)),
  );
  appChats.set(key, c);

  // Resume this app's chat after a reload, if the server still has it.
  showEmpty();
  if (savedChatIds[key]) {
    api("/api/chat/sessions")
      .then(({ sessions }) => sessions.some((s: ReaData) => s.id === savedChatIds[key]) && !c.chatId && connect(savedChatIds[key]))
      .catch(() => {});
  }
  return c.panel;
}

// Page content plus the app's chat: a docked column on wide screens, a drawer otherwise.
function chatShell(content: ReaData, key: string) {
  const shell = h("div", { class: "analysis-shell chat-shell", "data-chat-key": key }, content, appChat(key));
  shell.append(
    h(
      "button",
      {
        class: "primary chat-fab",
        type: "button",
        onclick: () => {
          shell.classList.add("chat-open");
          shell.querySelector<HTMLElement>(".app-chat .chat-prompt")?.focus();
        },
      },
      icon(["M7.9 20A9 9 0 1 0 4 16.1L2 22Z"]),
      h("span", { text: key === "general" ? "Ask REA" : "Ask about this app" }),
    ),
  );
  return shell;
}

// The analysis page reuses the shell; re-attach the shared panel if a tool page borrowed it.
function withAnalysisChat(analysis: ReaData) {
  analysis.page = chatShell(analysis.page, appKeyFor(analysis.path));
}
function attachChat(shell: ReaData) {
  const key = shell.dataset.chatKey;
  const panel = appChat(key);
  if (panel.parentElement !== shell) shell.insertBefore(panel, shell.querySelector(".chat-fab"));
}

// Tool pages follow whatever app is open in REA.
function wrapToolPageWithChat() {
  const key = appKeyFor(state.session?.target?.path ?? "");
  main.replaceChildren(chatShell(h("div", { class: "chat-shell-content" }, ...main.childNodes), key));
}
function syncToolChat() {
  const shell = main.querySelector<HTMLElement>(":scope > .chat-shell");
  if (!shell || !location.hash.startsWith("#/tool/")) return;
  const key = appKeyFor(state.session?.target?.path ?? "");
  if (shell.dataset.chatKey === key) return;
  shell.dataset.chatKey = key;
  shell.querySelector(".app-chat")?.remove();
  attachChat(shell);
  const label = shell.querySelector(".chat-fab span");
  if (label) label.textContent = key === "general" ? "Ask REA" : "Ask about this app";
}

function startAnalysis(detected: ReaData, kind: string) {
  if (state.status?.state !== "ready") return alert("REA isn't running yet. Wait for the green status at the top, or press Restart REA.");
  const active = state.analyses.find((a) => a.path === detected.path && a.state === "running" && a.page);
  if (active) return (location.hash = `#/analysis/${active.id}`);
  const analysis = runAnalysis(analysisDeps, detected, kind);
  withAnalysisChat(analysis);
  state.analyses = [analysis, ...state.analyses.filter((a) => a !== analysis && a.path !== detected.path)];
  renderAnalysisList();
  location.hash = `#/analysis/${analysis.id}`;
}

// XMLHttpRequest rather than fetch: it reports upload progress.
function uploadFile(file: File, onProgress: (fraction: number) => void): Promise<{ path: string; name: string; size: number }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/upload?name=${encodeURIComponent(file.name)}`);
    xhr.setRequestHeader("x-rea-gui-token", token);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      const data = JSON.parse(xhr.responseText || "{}");
      xhr.status < 300 ? resolve(data) : reject(new Error(data.error ?? `HTTP ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error("Can't reach the REA GUI server."));
    xhr.send(file);
  });
}

async function analyzePath(path: string) {
  const detected = await api(`/api/detect?path=${encodeURIComponent(path)}`);
  const kind = classify(detected);
  if (kind) startAnalysis(detected, kind);
  return { detected, kind };
}

// Writes for one analysis go out in order, and a newer snapshot replaces one still waiting.
const analysisWrites = new Map(); // id → { running: Promise, next: snapshot | null }
function saveAnalysis(analysis: ReaData) {
  state.analyses = [analysis, ...state.analyses.filter((a) => a !== analysis && a.path !== analysis.path)];
  renderAnalysisList();
  const { page, waiting, results, saveError, ...snapshot } = analysis;
  const slot = analysisWrites.get(analysis.id);
  if (slot) return void (slot.next = snapshot);
  const write = async (body: ReaData) => {
    try {
      await api(`/api/analyses/${analysis.id}`, { method: "PUT", body });
      analysis.saveError = null;
    } catch (err) {
      analysis.saveError = errorMessage(err);
      console.warn(`Couldn't save analysis ${analysis.id}: ${errorMessage(err)}`);
    }
    const next = analysisWrites.get(analysis.id)?.next;
    if (next) {
      analysisWrites.get(analysis.id).next = null;
      return write(next);
    }
    analysisWrites.delete(analysis.id);
  };
  analysisWrites.set(analysis.id, { next: null });
  write(snapshot);
}

async function removeAnalysis(analysis: ReaData) {
  await api(`/api/analyses/${analysis.id}`, { method: "DELETE" }).catch(() => {});
  state.analyses = state.analyses.filter((a) => a !== analysis);
  renderAnalysisList();
  if (location.hash === `#/analysis/${analysis.id}`) location.hash = "#/";
}

// Merge the server's list with analyses this tab is running, which may not be saved yet.
const analysesLoaded = (async () => {
  localStorage.removeItem("rea-gui-analyses"); // older builds kept only names here, never results
  try {
    const { analyses } = await api("/api/analyses");
    const live = state.analyses.filter((a) => a.page);
    state.analyses = [...live, ...analyses.filter((s: ReaData) => !live.some((a) => a.id === s.id || a.path === s.path))];
  } catch (err) {
    console.warn(`Couldn't load saved analyses: ${errorMessage(err)}`);
  }
  renderAnalysisList();
})();

// A saved analysis still marked running, with no page running it here, was cut off (tab closed or reloaded).
// A finished analysis with a failed check isn't shown as a clean success.
const shownState = (a: ReaData) => (a.state === "running" && !a.page ? "interrupted" : a.state === "done" && a.failedChecks ? "partial" : a.state);

function renderAnalysisList() {
  const list = $("#analysis-list");
  list.replaceChildren();
  if (!state.analyses.length) list.append(h("div", { class: "empty", text: "No analyses yet" }));
  const icon: Record<string, string> = { running: "◌", done: "✓", partial: "!", stopped: "■", interrupted: "■" };
  const why: Record<string, string> = { partial: "Finished, but a check couldn't complete", interrupted: "Didn't finish", stopped: "Stopped" };
  for (const a of state.analyses) {
    list.append(
      h(
        "button",
        { class: `nav-item analysis-item ${location.hash === `#/analysis/${a.id}` ? "active" : ""}`, title: why[shownState(a)] ? `${a.path}\n${why[shownState(a)]}` : a.path, onclick: () => (location.hash = `#/analysis/${a.id}`) },
        h("span", { class: `state ${shownState(a)}`, text: icon[shownState(a)] ?? "•" }),
        h("span", { class: "grow", text: a.name }),
        h("span", { class: "type", text: KINDS[a.kind]?.label ?? "" }),
      ),
    );
  }
}

async function renderAnalysisPage(id: string) {
  await analysesLoaded;
  const analysis = state.analyses.find((a) => a.id === id);
  if (!analysis) return renderMissingAnalysis();
  if (analysis.page) {
    if (analysis.page.classList.contains("chat-shell")) attachChat(analysis.page);
    return setMain(analysis.page);
  }
  setMain(h("div", { class: "empty", text: `Opening ${analysis.name}…` }));
  let saved;
  try {
    saved = await api(`/api/analyses/${id}`);
  } catch (err) {
    if (location.hash !== `#/analysis/${id}`) return;
    return setMain(
      h("h1", { text: analysis.name }),
      h("div", { class: "card" }, h("p", { class: "error-text", text: `Couldn't open the saved results: ${errorMessage(err)}` }), h("button", { class: "primary", text: "Run analysis again", onclick: () => analyzePath(analysis.path) })),
    );
  }
  // Another click may have opened it meanwhile; keep one page per analysis.
  const current = state.analyses.find((a) => a.id === id);
  if (!current?.page) {
    // Drill-downs need REA's tool list and depend on its run ID; don't guess before both are known.
    await Promise.race([statusReady, new Promise((r) => setTimeout(r, 3000))]);
    const open = state.analyses.find((a) => a.id === id)?.page;
    if (open) return location.hash === `#/analysis/${id}` && setMain(open);
    const restored = restoreAnalysis(analysisDeps, saved);
    withAnalysisChat(restored);
    state.analyses = state.analyses.map((a) => (a.id === id ? restored : a));
    renderAnalysisList();
  }
  if (location.hash === `#/analysis/${id}`) setMain(state.analyses.find((a) => a.id === id)?.page);
}

function renderMissingAnalysis() {
  setMain(
    h("h1", { text: "Analysis not found" }),
    h("div", { class: "card" }, h("p", { text: "It may have been removed, or replaced by a newer analysis of the same app." }), h("button", { class: "primary", text: "Start a new analysis", onclick: () => (location.hash = "#/") })),
  );
}

const debounce = <A extends unknown[]>(fn: (...args: A) => unknown, ms: number) => {
  let t: ReturnType<typeof setTimeout> | undefined;
  const debounced = (...args: A) => (clearTimeout(t), (t = setTimeout(() => fn(...args), ms)));
  debounced.cancel = () => clearTimeout(t);
  return debounced;
};

const SUPPORTED = "Mac apps · Electron apps · Android APK · iOS IPA · Windows EXE/DLL · app.asar and JavaScript projects · Mach-O and Linux binaries · WebAssembly · SQLite";

async function renderHome() {
  // The home page is redrawn when REA's tools arrive; keep whatever was already typed.
  const typed = document.querySelector<HTMLInputElement>("#target-path")?.value ?? "";
  // A visible label and hint sit above the field. The button stays enabled and validates on press.
  const input = h("input", { id: "target-path", class: "big-input", spellcheck: false, autocomplete: "off", value: typed });
  const hint = h("div", { class: "detect-hint muted", "aria-live": "polite" });
  const go = h("button", { class: "primary big", text: "Start analysis" });
  let pending: { detected: ReaData; kind: string } | null = null;
  const showError = (text: string) => {
    hint.className = "detect-hint error-text";
    hint.textContent = text;
    input.setAttribute("aria-invalid", "true");
  };
  const runCheck = async () => {
    const value = input.value.trim();
    pending = null;
    input.removeAttribute("aria-invalid");
    if (!value) return hint.replaceChildren(), (hint.className = "detect-hint muted");
    let detected;
    try {
      detected = await api(`/api/detect?path=${encodeURIComponent(value)}`);
    } catch (err) {
      return showError(errorMessage(err));
    }
    if (input.value.trim() !== value) return;
    const kind = classify(detected);
    if (!detected.exists) return showError("Nothing exists at that path. Check it for typos, or choose the file instead.");
    if (!kind) return showError("This folder isn't an app. Choose the .app, .apk, .ipa or app.asar inside it.");
    pending = { detected, kind };
    hint.className = "detect-hint";
    hint.replaceChildren(h("span", { class: "badge accent", text: KINDS[kind]?.label }), " ", h("span", { class: "muted", text: KINDS[kind]?.blurb }));
  };
  const check = debounce(runCheck, 200);
  input.addEventListener("input", check);
  input.addEventListener("keydown", (e) => e.key === "Enter" && go.click());
  go.addEventListener("click", async () => {
    // A check still waiting from the last keystroke would overwrite this press's result.
    check.cancel();
    if (!input.value.trim()) return showError("Enter the path to an app or file, or pick an installed app below.");
    // Re-check on press so a debounced check still in flight can't start the wrong path.
    await runCheck();
    if (pending) startAnalysis(pending.detected, pending.kind);
  });

  const filter = h("input", { type: "search", placeholder: "Filter apps…", class: "filter", "aria-label": "Filter installed apps" });
  const grid = h("div", { class: "app-grid" }, h("div", { class: "empty", text: "Looking for installed apps…" }));

  // On a server, files come from this computer by upload (button or drag and drop).
  const upload = async (file: File | undefined) => {
    if (!file) return;
    if (!file) return;
    hint.className = "detect-hint muted";
    hint.textContent = `Uploading ${file.name}…`;
    try {
      const saved = await uploadFile(file, (fraction: number) => (hint.textContent = `Uploading ${file.name}… ${Math.round(fraction * 100)}%`));
      input.value = saved.path;
      await runCheck();
      if (pending) startAnalysis(pending.detected, pending.kind);
    } catch (err) {
      showError(`Upload failed: ${errorMessage(err)}`);
    }
  };
  const fileInput = h("input", { type: "file", class: "hidden", onchange: (e) => upload(e.target.files?.[0]) });
  const pickButtons = serverMode
    ? [h("button", { text: "Upload file", onclick: () => fileInput.click() }), h("button", { class: "ghost", text: "Browse server", title: "Pick a file that's already on the server", onclick: async () => ((input.value = (await pickPath(input.value)) ?? input.value), check()) })]
    : [h("button", { text: "Choose file", onclick: async () => ((input.value = (await pickPath(input.value)) ?? input.value), check()) })];
  const hero = h(
    "div",
    { class: "card hero" },
    h("label", { class: "field-label", for: "target-path", text: "App or file to analyze" }),
    h("div", {
      class: "muted small",
      text: serverMode
        ? `Upload a file from your computer (or drop it here), or enter the path of a file already on the server. Works with ${SUPPORTED}. A Mac .app is a folder: zip it first, or upload its app.asar or main executable.`
        : `Paste its full path, for example /Applications/Slack.app or ~/Downloads/app.apk. Works with ${SUPPORTED}.`,
    }),
    hint,
    h("div", { class: "input-row" }, input, ...pickButtons, go),
    fileInput,
  );
  if (serverMode) {
    hero.addEventListener("dragover", (e) => (e.preventDefault(), hero.classList.add("drop")));
    hero.addEventListener("dragleave", () => hero.classList.remove("drop"));
    hero.addEventListener("drop", (e) => (e.preventDefault(), hero.classList.remove("drop"), upload(e.dataTransfer?.files[0])));
  }

  setMain(
    h("h1", { class: "hero-title", text: "What do you want to look inside?" }),
    h("p", { class: "lede", text: "REA (Reverse Engineer Anything) reads apps and binaries without running them, then explains what it found: who signed it, what it can access, how it's built and what it exposes." }),
    hero,
    serverMode ? null : h("div", { class: "row-between" }, h("h2", { text: "Or pick an installed app" }), filter),
    serverMode ? null : grid,
    h("p", { class: "muted small legal-note", text: "Only analyze software you own or have permission to analyze, and follow its license and the law where you live." }),
    h("div", { id: "readiness" }),
  );
  input.focus();
  if (typed.trim()) runCheck();
  renderReadiness();

  if (serverMode) return;
  if (!state.apps) {
    try {
      state.apps = (await api("/api/apps")).apps;
    } catch (err) {
      state.apps = [];
      grid.replaceChildren(h("div", { class: "empty", text: `Could not list apps: ${errorMessage(err)}` }));
      return;
    }
  }
  const draw = () => {
    const q = filter.value.toLowerCase();
    const apps = (state.apps ?? []).filter((a: ReaData) => !q || a.name.toLowerCase().includes(q));
    grid.replaceChildren(
      ...apps.map((app: ReaData) =>
        h(
          "button",
          { class: "app-card", title: `Analyze ${app.path}`, onclick: () => analyzePath(app.path) },
          h("img", { class: "app-icon", loading: "lazy", alt: "", src: iconUrl(app.path), onerror: (e: ReaData) => e.target.classList.add("missing") }),
          h("div", { class: "app-text" }, h("div", { class: "name", text: app.name }), h("div", { class: "type", text: app.kind === "electron" ? "Electron app" : "Mac app" })),
        ),
      ),
    );
    if (!apps.length) grid.append(h("div", { class: "empty", text: state.apps?.length ? "No apps match." : "No installed apps found. Paste a path above." }));
  };
  filter.addEventListener("input", draw);
  draw();
}

// Plain-language capability list: which kinds of analysis work here, and what to install otherwise.
const CAPABILITIES: [string, string[]][] = [
  ["App signatures, bundles and Mach-O binaries", ["inspect_signature", "inspect_macho", "inspect_artifact"]],
  ["JavaScript and Electron apps", ["analyze_javascript_application", "inspect_electron_fuses"]],
  ["Android app layout and Flutter", ["project_android_application_graph", "identify_flutter_build"]],
  ["Android decompiling (classes and methods)", ["inspect_android_package", "search_android_classes"]],
  ["Android devices over USB", ["list_adb_devices"]],
  [".NET assemblies", ["inspect_managed_artifact"]],
  ["Windows resources", ["inspect_pe_resources"]],
  ["WebAssembly", ["inspect_wasm_artifact"]],
  ["SQLite databases", ["inspect_sqlite_database"]],
  ["Live web pages (Chrome DevTools)", ["inspect_web_page"]],
];

function renderReadiness() {
  const el = $opt("#readiness");
  if (!el) return;
  const session = state.session;
  if (!session || !state.tools.length) return el.replaceChildren();
  const rows = CAPABILITIES.map(([label, names]) => {
    const present = names.filter(toolExists);
    if (!present.length) return null;
    // target_* reasons describe the currently open file, not this machine.
    const blocked = present.map((n) => [n, availabilityOf(n)] as const).find(([, a]) => a?.available === false && !a.reason?.startsWith("target_"));
    return [label, blocked?.[1] ?? null] as [string, ReaData];
  }).filter((row): row is [string, ReaData] => row !== null);
  const nativeReady = session.providers.some((p: ReaData) => p.status === "available");
  rows.push(["Decompiling native code (pseudocode, cross-references)", nativeReady ? null : { reason: "no decompiler connected", remediation: "Install Hopper, Ghidra, IDA or Kuna and configure it for REA." }]);
  const ready = rows.filter(([, b]) => !b).length;
  el.replaceChildren(
    h(
      "details",
      { class: "card readiness" },
      h("summary", {}, h("strong", { text: serverMode ? "What works on this server" : "What works on this computer" }), h("span", { class: "muted", text: ` · ${ready} of ${rows.length} kinds of analysis ready` })),
      h(
        "ul",
        { class: "capabilities" },
        ...rows.map(([label, blocked]) =>
          h(
            "li",
            { class: blocked ? "blocked" : "ready" },
            h("span", { class: "cap-icon", text: blocked ? "○" : "✓" }),
            h("span", { class: "grow", text: label }),
            blocked ? h("span", { class: "muted small", text: blocked.remediation ?? blocked.reason ?? "Needs setup" }) : h("span", { class: "muted small", text: "Ready" }),
          ),
        ),
      ),
    ),
  );
}

// ---------- JSON schema → form ----------
function resolveRef(schema: ReaData, root: HTMLElement) {
  let s = schema;
  for (let i = 0; s?.$ref && i < 10; i++) {
    const path = s.$ref.replace(/^#\//, "").split("/");
    s = path.reduce((node: ReaData, key: string) => node?.[decodeURIComponent(key)], root);
  }
  return s ?? {};
}

function describeField(schema: ReaData, root: ReaData): ReaData {
  const s = resolveRef(schema, root);
  const variants = s.anyOf ?? s.oneOf;
  if (variants) {
    const resolved = variants.map((v: ReaData) => resolveRef(v, root));
    const nonNull = resolved.filter((v: ReaData) => v.type !== "null");
    const literals = nonNull.flatMap((v: ReaData) => (v.const !== undefined ? [v.const] : v.enum ?? [null]));
    if (literals.length && !literals.includes(null)) return { kind: "enum", options: literals, schema: s };
    if (nonNull.length === 1) return { ...describeField(nonNull[0], root), schema: { ...nonNull[0], ...s } };
    return { kind: "json", schema: s };
  }
  const type = Array.isArray(s.type) ? s.type.find((t: ReaData) => t !== "null") : s.type;
  if (s.enum) return { kind: "enum", options: s.enum, schema: s };
  if (s.const !== undefined) return { kind: "enum", options: [s.const], schema: s };
  if (type === "string") return { kind: "string", schema: s };
  if (type === "integer" || type === "number") return { kind: "number", schema: s };
  if (type === "boolean") return { kind: "boolean", schema: s };
  if (type === "array") {
    const items = resolveRef(s.items ?? {}, root);
    if (items.type === "string" || items.type === "number" || items.type === "integer")
      return { kind: "lines", itemType: items.type, schema: s };
  }
  return { kind: "json", schema: s };
}

// A minimal valid-looking value for a schema: required keys, first variant, enum defaults.
function skeleton(schema: ReaData, root: ReaData, depth = 0): unknown {
  const s = resolveRef(schema, root);
  if (depth > 4) return null;
  if (s.default !== undefined) return s.default;
  if (s.const !== undefined) return s.const;
  if (s.enum) return s.enum[0];
  const variants = s.oneOf ?? s.anyOf;
  if (variants) {
    const first = variants.map((v: ReaData) => resolveRef(v, root)).find((v: ReaData) => v.type !== "null") ?? variants[0];
    return skeleton(first, root, depth + 1);
  }
  const type = Array.isArray(s.type) ? s.type.find((t: ReaData) => t !== "null") : s.type;
  if (type === "object" || s.properties) {
    const out: Record<string, unknown> = {};
    const required = s.required ?? [];
    for (const key of required) out[key] = skeleton(s.properties?.[key] ?? {}, root, depth + 1);
    return out;
  }
  if (type === "array") return [];
  if (type === "string") return s.pattern?.startsWith("^ev_") ? "ev_…" : "";
  if (type === "integer" || type === "number") return s.minimum ?? 0;
  if (type === "boolean") return false;
  return null;
}

const looksLikePath = (name: string) => /(^|_)(path|paths|file|dir|directory|root|input|output|asar|bundle|binary|apk)(_|$)/.test(name);

function buildForm(tool: ReaData) {
  const root = tool.inputSchema ?? {};
  const props = root.properties ?? {};
  const required = new Set(root.required ?? []);
  const keys = Object.keys(props).sort((a, b) => Number(required.has(b)) - Number(required.has(a)));
  const fields: { key: string; el: HTMLElement; read: () => unknown; write: (v: ReaData) => void }[] = [];

  for (const key of keys) {
    const desc = describeField(props[key], root);
    const s = desc.schema;
    let input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
    let read: () => unknown;
    let write: (v: ReaData) => void;
    const placeholder = s.default !== undefined ? `default: ${JSON.stringify(s.default)}` : "";
    switch (desc.kind) {
      case "enum":
        input = h(
          "select",
          {},
          h("option", { value: "", text: placeholder ? `(${placeholder})` : "(unset)" }),
          ...desc.options.map((o: ReaData) => h("option", { value: JSON.stringify(o), text: String(o) })),
        );
        read = () => (input.value ? JSON.parse(input.value) : undefined);
        write = (v: ReaData) => (input.value = v === undefined ? "" : JSON.stringify(v));
        break;
      case "boolean":
        input = h(
          "select",
          {},
          h("option", { value: "", text: placeholder ? `(${placeholder})` : "(unset)" }),
          h("option", { value: "true", text: "true" }),
          h("option", { value: "false", text: "false" }),
        );
        read = () => (input.value === "" ? undefined : input.value === "true");
        write = (v: ReaData) => (input.value = v === undefined ? "" : String(v));
        break;
      case "number":
        input = h("input", { type: "number", placeholder, min: s.minimum, max: s.maximum, step: s.type === "integer" ? 1 : "any" });
        read = () => (input.value === "" ? undefined : Number(input.value));
        write = (v: ReaData) => (input.value = v ?? "");
        break;
      case "string":
        input = h("input", { placeholder: placeholder || s.format || "", spellcheck: false });
        read = () => (input.value === "" ? undefined : input.value);
        write = (v: ReaData) => (input.value = v ?? "");
        break;
      case "lines":
        input = h("textarea", { placeholder: "One value per line", rows: 3, spellcheck: false });
        read = () => {
          const lines = input.value.split("\n").map((l: ReaData) => l.trim()).filter(Boolean);
          if (!lines.length) return undefined;
          return desc.itemType === "string" ? lines : lines.map(Number);
        };
        write = (v: ReaData) => (input.value = Array.isArray(v) ? v.join("\n") : "");
        break;
      default: {
        const template = skeleton(props[key], root);
        const templateText = template !== null && template !== undefined ? JSON.stringify(template, null, 2) : "";
        input = h("textarea", { placeholder: placeholder || templateText || "JSON value", rows: Math.min(8, Math.max(3, templateText.split("\n").length)), spellcheck: false });
        if (templateText) input.dataset.template = templateText;
        read = () => {
          if (!input.value.trim()) return undefined;
          try {
            return JSON.parse(input.value);
          } catch {
            throw new Error(`${key}: invalid JSON`);
          }
        };
        write = (v: ReaData) => (input.value = v === undefined ? "" : JSON.stringify(v, null, 2));
      }
    }

    const control =
      (desc.kind === "string" || desc.kind === "lines") && looksLikePath(key)
        ? h(
            "div",
            { class: "input-row" },
            input,
            h("button", {
              type: "button",
              text: "Choose file",
              onclick: async () => {
                const picked = await pickPath(desc.kind === "lines" ? "" : input.value);
                if (!picked) return;
                input.value = desc.kind === "lines" && input.value.trim() ? `${input.value.trim()}\n${picked}` : picked;
              },
            }),
          )
        : input;

    const templateButton =
      input.dataset?.template
        ? h("button", { type: "button", class: "link", text: "Insert template", onclick: () => (input.value = input.dataset.template ?? "") })
        : null;
    // Offer evidence from earlier results for fields that reference retained Evidence.
    const evidencePicker =
      input.dataset?.template?.includes("ev_…") && recentEvidence.length
        ? h(
            "select",
            {
              class: "evidence-picker",
              onchange: (e) => {
                if (!e.target.value) return;
                const value = JSON.parse((input.dataset.template ?? "").replace('"ev_…"', JSON.stringify(e.target.value)));
                input.value = JSON.stringify(value, null, 2);
              },
            },
            h("option", { value: "", text: "Use evidence from an earlier result…" }),
            ...recentEvidence.map((e) => h("option", { value: e.id, text: e.label })),
          )
        : null;
    const typeLabel = desc.kind === "lines" ? `${desc.itemType}[]` : desc.kind === "json" ? s.type ?? "json" : desc.kind;
    fields.push({
      key,
      read,
      write,
      el: h(
        "div",
        { class: "field" },
        h(
          "label",
          {},
          key,
          required.has(key) ? h("span", { class: "req", text: "*" }) : h("span", { class: "type pui-only", text: "(optional)" }),
          h("span", { class: "type", text: typeLabel }),
          templateButton,
        ),
        evidencePicker,
        control,
        s.description ? h("div", { class: "help", text: s.description }) : null,
      ),
    });
  }

  return {
    fields,
    read() {
      const args: Record<string, unknown> = {};
      for (const f of fields) {
        const v = f.read();
        if (v !== undefined) args[f.key] = v;
      }
      return args;
    },
    write(args: Record<string, unknown> = {}) {
      for (const f of fields) f.write(args[f.key]);
    },
  };
}

// ---------- tool page ----------
function renderTool(tool: ReaData) {
  const form = buildForm(tool);
  const raw = h("textarea", { rows: 12, spellcheck: false, class: "hidden" });
  const formEl = h("div", { class: "form" }, ...form.fields.map((f) => f.el));
  if (!form.fields.length) formEl.append(h("div", { class: "help", text: "This tool takes no arguments." }));
  else if (tool.inputSchema?.required?.length) formEl.prepend(h("p", { class: "muted small pui-only", text: "Required fields are marked with an asterisk (*)." }));
  let rawMode = false;

  const readArgs = () => (rawMode ? JSON.parse(raw.value || "{}") : form.read());
  const toggleRaw = h("button", {
    type: "button",
    class: "ghost",
    text: "Edit as JSON",
    onclick: () => {
      try {
        if (!rawMode) raw.value = JSON.stringify(form.read(), null, 2);
        else form.write(JSON.parse(raw.value || "{}"));
      } catch (err) {
        return alert(errorMessage(err));
      }
      rawMode = !rawMode;
      raw.classList.toggle("hidden", !rawMode);
      formEl.classList.toggle("hidden", rawMode);
      toggleRaw.textContent = rawMode ? "Edit as form" : "Edit as JSON";
    },
  });

  const runButton = h("button", { class: "primary", text: "Run tool" });
  const resultEl = h("div", { class: "result" });
  runButton.addEventListener("click", async () => {
    let args;
    try {
      args = readArgs();
    } catch (err) {
      return alert(errorMessage(err));
    }
    runButton.disabled = true;
    try {
      const { callId } = await api("/api/call", { method: "POST", body: { name: tool.name, arguments: args } });
      state.current = { callId, name: tool.name, startedAt: Date.now(), resultEl };
      // Runs belong to the app they act on: a path argument, else the file open in REA.
      const pathArg = Object.values(args).find((v) => typeof v === "string" && v.startsWith("/"));
      const runApp = typeof pathArg === "string" ? appKeyFor(pathArg) : state.session?.target ? appKeyFor(state.session.target.path) : null;
      state.history.unshift({ callId, name: tool.name, args, at: Date.now(), state: "running", app: runApp });
      saveHistory();
      renderRunning();
    } catch (err) {
      resultEl.replaceChildren(h("pre", { class: "text-block error-box", text: errorMessage(err) }));
    } finally {
      runButton.disabled = false;
    }
  });

  const description = h("div", { class: "description collapsed", text: tool.description ?? "" });
  const examples = (tool.inputSchema?.examples ?? tool._meta?.examples ?? []).filter((ex: ReaData) => ex && Object.keys(ex).length);

  setMain(
    h("h1", {}, h("code", { text: tool.name })),
    tool.title && tool.title !== tool.name ? h("p", { class: "lede", text: tool.title }) : null,
    availabilityOf(tool.name)?.available === false
      ? h("p", {
          class: "warning",
          text: availabilityOf(tool.name)?.reason?.startsWith("target_")
            ? `Doesn't apply to the file open in REA (${state.session?.target?.path.split("/").pop() ?? "none"}). ${availabilityOf(tool.name)?.remediation ?? ""}`
            : `Needs setup on this machine. ${availabilityOf(tool.name)?.remediation ?? ""}`,
        })
      : null,
    tool.annotations?.destructiveHint && tool.annotations?.readOnlyHint === false
      ? h("p", { class: "warning", text: "This tool can change state (files, devices, sessions or annotations). Review the arguments before running." })
      : null,
    description,
    (tool.description ?? "").length > 240
      ? h("button", {
          class: "link",
          text: "Show full description",
          onclick: (e) => {
            description.classList.toggle("collapsed");
            (e.target as HTMLElement).textContent = description.classList.contains("collapsed") ? "Show full description" : "Show less description";
          },
        })
      : null,
    h("h2", { text: "Arguments" }),
    examples.length
      ? h(
          "div",
          { class: "examples" },
          ...examples.map((ex: ReaData, i: number) =>
            h("button", {
              class: "ghost small",
              title: JSON.stringify(ex.input ?? ex, null, 2),
              text: `Use example${examples.length > 1 ? ` ${i + 1}` : ""}: ${ex.title ?? Object.keys(ex.input ?? ex).join(", ")}`,
              onclick: () => form.write(ex.input ?? ex),
            }),
          ),
        )
      : null,
    formEl,
    raw,
    h("div", { class: "actions", style: "margin-top:16px" }, runButton, toggleRaw),
    resultEl,
  );
  wrapToolPageWithChat();

  if (state.pendingArgs) form.write(state.pendingArgs);
  state.pendingArgs = null;

  if (state.reopenCall) {
    const callId = state.reopenCall;
    state.reopenCall = null;
    state.current = { callId, name: tool.name, resultEl };
    showCall(callId);
  } else {
    state.current = null;
  }
  if (state.autoRun) {
    state.autoRun = false;
    if (state.status?.state === "ready") runButton.click();
  }
}

// ---------- results ----------
function renderRunning() {
  const cur = state.current;
  if (!cur) return;
  const cancel = h("button", {
    class: "ghost danger",
    text: "Cancel",
    onclick: () => api(`/api/calls/${cur.callId}/cancel`, { method: "POST" }).catch(() => {}),
  });
  const elapsed = h("span", { class: "meta", text: "0s" });
  const timer = setInterval(() => {
    if (state.current !== cur) return clearInterval(timer);
    elapsed.textContent = `${Math.round((Date.now() - (cur.startedAt ?? Date.now())) / 1000)}s`;
  }, 500);
  cur.timer = timer;
  cur.resultEl.replaceChildren(
    h(
      "div",
      { class: "result-header" },
      h("span", { class: "pill running", text: "Running" }),
      h("span", { class: "title", text: cur.name }),
      elapsed,
      h("span", { class: "meta", id: "progress-message" }),
      h("span", { class: "spacer" }),
      cancel,
    ),
    h("div", { class: "progress", id: "progress-bar" }, h("div")),
  );
  const p = state.progress.get(cur.callId);
  if (p) updateProgress(p);
}

function updateProgress(p: ReaData) {
  const bar = $opt("#progress-bar");
  const msg = $opt("#progress-message");
  if (msg) msg.textContent = p.message ?? (p.total ? `${p.progress}/${p.total}` : "");
  if (bar && p.total) {
    bar.classList.add("determinate");
    (bar.firstChild as HTMLElement).style.width = `${Math.min(100, (p.progress / p.total) * 100)}%`;
  }
}

async function showCall(callId: string) {
  const cur = state.current;
  if (!cur || cur.callId !== callId) return;
  let record;
  try {
    record = await api(`/api/calls/${callId}`);
  } catch {
    cur.resultEl.replaceChildren(h("div", { class: "empty", text: "This run's result is no longer held by the server. Run it again." }));
    return;
  }
  if (record.state === "running") {
    cur.startedAt = record.startedAt;
    return renderRunning();
  }
  clearInterval(cur.timer);
  cur.onDone?.(record);
  renderResult(cur.resultEl, record);
}

function renderResult(container: HTMLElement, record: ReaData) {
  const duration = record.finishedAt && record.startedAt ? `${((record.finishedAt - record.startedAt) / 1000).toFixed(1)}s` : "";
  const failed = record.state === "error" || record.result?.isError;
  const payload = record.state === "error" ? { error: record.error } : record.result;
  const rawText = JSON.stringify(payload, null, 2);

  const header = h(
    "div",
    { class: "result-header" },
    h("span", {
      class: `pill ${failed ? "error" : "done"}`,
      text: !failed ? "Done" : record.state !== "error" ? "Tool error" : record.error.message.startsWith("Cancelled") ? "Cancelled" : "Failed",
    }),
    h("span", { class: "title", text: record.name }),
    h("span", { class: "meta", text: `${duration} · ${formatBytes(rawText.length)}` }),
    h("span", { class: "spacer" }),
    h("button", { class: "ghost", text: "Copy result", onclick: () => navigator.clipboard.writeText(rawText) }),
    h("button", {
      class: "ghost",
      text: "Download JSON",
      onclick: () => {
        const a = h("a", { href: URL.createObjectURL(new Blob([rawText], { type: "application/json" })), download: `${record.name}-${record.id}.json` });
        a.click();
        URL.revokeObjectURL(a.href);
      },
    }),
  );

  const readable = h("div");
  const drills = h("div", { class: "drills" });
  if (record.state === "error") {
    readable.append(h("pre", { class: "text-block error-box", text: `${record.error.message}${record.error.data ? `\n\n${JSON.stringify(record.error.data, null, 2)}` : ""}` }));
  } else {
    const result = record.result ?? {};
    const texts = (result.content ?? []).filter((c: ReaData) => c.type === "text").map((c: ReaData) => tryParse(c.text));
    // Show structuredContent only when the text content doesn't already carry it.
    if (result.structuredContent && !texts.some((t: ReaData) => t !== undefined)) {
      readable.append(h("div", { class: "section-label", text: "Structured result" }), jsonTree(result.structuredContent, 2));
    }
    for (const item of result.content ?? []) {
      if (item.type === "text") {
        const parsed = tryParse(item.text);
        if (result.isError && parsed?.error?.message) {
          readable.append(errorCard(parsed.error, record));
          continue;
        }
        if (isEvidence(parsed)) {
          rememberEvidence(parsed);
          readable.append(renderEvidence(parsed, evidenceCtx(drills)));
        } else if (parsed?.result && typeof parsed.result === "object" && !result.isError) {
          readable.append(renderFacts(h, jsonTree, parsed.result));
          if (record.name === "open_binary" && parsed.result.path) readable.append(nextStepButtons(parsed.result) ?? "");
        } else {
          readable.append(
            h("div", { class: "section-label", text: "Text content" }),
            parsed !== undefined && typeof parsed === "object" ? jsonTree(parsed, 2) : h("pre", { class: `text-block ${result.isError ? "error-box" : ""}`, text: item.text }),
          );
        }
      } else if (item.type === "image") {
        readable.append(h("img", { src: `data:${item.mimeType};base64,${item.data}`, style: "max-width:100%;border-radius:8px" }));
      } else {
        readable.append(h("div", { class: "section-label", text: item.type }), jsonTree(item, 1));
      }
    }
  }

  const rawView = h("pre", { class: "text-block hidden" });
  const tabButtons = ["Readable", "Raw JSON"].map((label, i) =>
    h("button", {
      class: i === 0 ? "active" : "",
      text: label,
      onclick: () => {
        tabButtons.forEach((b, j) => b.classList.toggle("active", i === j));
        readable.classList.toggle("hidden", i !== 0);
        rawView.classList.toggle("hidden", i !== 1);
        // Render large raw JSON lazily.
        if (i === 1 && !rawView.textContent) rawView.textContent = rawText.length > 5_000_000 ? `${rawText.slice(0, 5_000_000)}\n… truncated, use Download` : rawText;
      },
    }),
  );
  readable.prepend(drills);
  container.replaceChildren(header, h("div", { class: "tabs" }, ...tabButtons), readable, rawView);
}

// REA errors carry a code, message and textual remediation such as
// "rerun analyze_javascript_application with integrity_policy=record-and-continue".
function errorCard(error: ReaData, record: ReaData) {
  const remediation = error.remediation?.action ?? "";
  const card = h(
    "div",
    { class: "text-block error-box" },
    h("div", {}, h("strong", { text: error.code ?? "error" }), error.category ? ` · ${error.category}` : ""),
    h("p", { text: error.message }),
  );
  if (remediation && remediation !== error.message) card.append(h("p", { text: `Suggested: ${remediation}` }));
  const match = remediation.match(/rerun (\w+) with ([\w.]+)=([\w.-]+)/) ?? error.message.match(/rerun (\w+) with ([\w.]+)=([\w.-]+)/);
  if (match && match[1] === record.name) {
    const [, tool, key, rawValue] = match;
    const value = /^(true|false|\d+(\.\d+)?)$/.test(rawValue) ? JSON.parse(rawValue) : rawValue;
    card.append(
      h("button", {
        class: "primary",
        text: `Retry with ${key}=${rawValue}`,
        onclick: () => runQuick(tool, { ...record.arguments, [key]: value }),
      }),
    );
  }
  if (error.details) card.append(h("div", { class: "section-label", text: "Details" }), jsonTree(error.details, 1));
  return card;
}

function evidenceCtx(drills: HTMLElement): EvidenceContext {
  const ctx: EvidenceContext = {
    h,
    jsonTree,
    callAndWait,
    viewTool: state.tools.find((t) => t.name === "inspect_analysis_view"),
    drill: (title: string, args: ReaData) => {
      drills.prepend(drillPanel(ctx, title, args));
      drills.scrollIntoView({ behavior: "smooth", block: "start" });
    },
    renderFailure: (record: ReaData, parsed: ReaData) =>
      parsed?.error ? errorCard(parsed.error, record) : h("pre", { class: "text-block error-box", text: record.error?.message ?? JSON.stringify(record.result ?? record, null, 2) }),
  };
  return ctx;
}

function tryParse(text: string) {
  if (typeof text !== "string" || !/^\s*[[{]/.test(text)) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function formatBytes(n: number) {
  return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
}

// Collapsible JSON tree; children render lazily when a node is opened.
function jsonTree(value: ReaData, openDepth = 1): HTMLElement {
  return h("div", { class: "tree" }, treeNode(null, value, 0, openDepth));
}

function leafValue(value: ReaData) {
  if (value === null) return h("span", { class: "z", text: "null" });
  if (typeof value === "string") return h("span", { class: "s", text: JSON.stringify(value) });
  if (typeof value === "number") return h("span", { class: "n", text: String(value) });
  if (typeof value === "boolean") return h("span", { class: "b", text: String(value) });
  return h("span", { text: String(value) });
}

function treeNode(key: string | null, value: ReaData, depth: number, openDepth: number) {
  const keyEl = key !== null ? [h("span", { class: "k", text: key }), ": "] : [];
  if (value === null || typeof value !== "object") return h("div", { class: "leaf" }, ...keyEl, leafValue(value));
  const isArray = Array.isArray(value);
  const entries = isArray ? value.map((v, i) => [String(i), v]) : Object.entries(value);
  const hint = isArray ? `[${entries.length}]` : `{${entries.length}}`;
  const details = h("details", {}, h("summary", {}, ...keyEl, h("span", { class: "hint", text: hint })));
  let rendered = 0;
  const renderMore = () => {
    const batch = entries.slice(rendered, rendered + 200);
    details.querySelector(":scope > .more")?.remove();
    for (const [k, v] of batch) details.append(treeNode(k, v, depth + 1, openDepth));
    rendered += batch.length;
    if (rendered < entries.length) {
      details.append(h("div", { class: "more" }, h("button", { class: "link", text: `Show ${Math.min(200, entries.length - rendered)} more of ${entries.length - rendered}…`, onclick: renderMore })));
    }
  };
  details.addEventListener("toggle", () => {
    if (details.open && rendered === 0) renderMore();
  });
  if (depth < openDepth && entries.length <= 200) details.open = true;
  return details;
}

// ---------- server-side path picker ----------
async function pickPath(start: string): Promise<string | null> {
  const dialog = $<HTMLDialogElement>("#picker");
  const pathInput = $<HTMLInputElement>("#picker-path");
  const itemsEl = $("#picker-items");
  let current: { path: string; parent: string | null } | null = null;

  const load = async (path: string) => {
    try {
      const listing = await api(`/api/fs?path=${encodeURIComponent(path ?? "")}`);
      current = listing;
      pathInput.value = listing.path;
      itemsEl.replaceChildren(
        ...listing.items.map((item: ReaData) =>
          h("button", {
            type: "button",
            class: "nav-item",
            text: `${item.dir ? "📁" : "📄"} ${item.name}`,
            onclick: () => (item.dir ? load(item.path) : finish(item.path)),
            ondblclick: () => finish(item.path),
          }),
        ),
      );
      if (!listing.items.length) itemsEl.append(h("div", { class: "empty", text: "Empty folder" }));
    } catch (err) {
      itemsEl.replaceChildren(h("div", { class: "empty", text: errorMessage(err) }));
    }
  };

  let resolvePick = (_path: string | null) => {};
  const finish = (path: string | null) => {
    dialog.close();
    resolvePick(path);
  };
  const result = new Promise<string | null>((resolve) => (resolvePick = resolve));
  $("#picker-up").onclick = () => current?.parent && load(current.parent);
  $("#picker-go").onclick = () => load(pathInput.value);
  pathInput.onkeydown = (e) => e.key === "Enter" && (e.preventDefault(), load(pathInput.value));
  $("#picker-select").onclick = () => finish(current?.path ?? null);
  dialog.onclose = () => resolvePick(null);

  const startDir = start?.trim() ? start.trim().replace(/\/[^/]*\.[^/]+$/, "") : "";
  await load(startDir);
  dialog.showModal();
  return result;
}

// ---------- boot ----------
$("#nav-tools").addEventListener("click", () => (location.hash = "#/tools"));
$("#target-close").addEventListener("click", () => runQuick("close_binary", {}));
$("#nav-home").addEventListener("click", () => (location.hash = "#/"));
$("#toggle-log").addEventListener("click", () => $("#log-panel").classList.toggle("hidden"));
$("#close-log").addEventListener("click", () => $("#log-panel").classList.add("hidden"));
if (passwordAuth) $("#sign-out").classList.remove("hidden");
$("#sign-out").addEventListener("click", () => fetch("/api/logout", { method: "POST" }).finally(() => location.replace("/login.html")));
$("#restart").addEventListener("click", () => api("/api/restart", { method: "POST" }).catch((err) => alert(errorMessage(err))));

// ---------- Chat ----------
// The server keeps each chat's event log; the browser rebuilds the transcript from it on every connect.
interface ChatProvider {
  id: string;
  label: string;
  keyLabel: string;
  keyPlaceholder: string;
  keyEnv: string;
  keyUrl?: string;
  serverKey?: boolean;
}
interface ChatModel {
  id: string;
  label: string;
  vendor?: string;
  note?: string;
  reasoning?: boolean;
}
interface ChatConfig {
  agents: { id: string; label: string; description: string; usesRea: boolean }[];
  providers: ChatProvider[];
  models: ChatModel[];
  efforts: string[];
  defaultEffort: string;
  serverKey: boolean;
}
interface ChatSummary {
  id: string;
  provider: string;
  agent: string;
  model: string;
  title: string | null;
  busy: boolean;
  createdAt: number;
  scope: string | null;
}

const chatState: {
  config: ChatConfig | null;
  configError: string | null;
  sessions: ChatSummary[];
  active: string | null;
  provider: string;
  keys: Record<string, string>;
  models: Record<string, string>;
  catalogs: Record<string, ChatModel[]>;
  catalogErrors: Record<string, string>;
  settingsOpen: boolean | null;
  agent: string | null;
  effort: string | null;
  busy: boolean;
  es: EventSource | null;
  view: ((event: ReaData) => void) | null;
} = {
  config: null,
  configError: null,
  sessions: [],
  active: sessionStorage.getItem("rea-chat-active"),
  provider: localStorage.getItem("rea-chat-provider") ?? "anthropic",
  // Keys and models are kept per provider, so switching back and forth loses nothing.
  keys: {}, // provider → key, read lazily from localStorage
  models: {}, // provider → chosen model id
  catalogs: {}, // provider → its models, loaded on demand (Anthropic's come with the config)
  catalogErrors: {},
  settingsOpen: null, // null: open only until a key is saved
  agent: localStorage.getItem("rea-chat-agent"),
  effort: localStorage.getItem("rea-chat-effort"),
  busy: false,
  es: null,
  view: null, // renderer for the visible transcript
};

async function loadChatConfig() {
  try {
    const cfg = await api("/api/chat/config");
    chatState.config = cfg;
    chatState.configError = null;
    chatState.catalogs.anthropic = cfg.models;
    if (!cfg.models.some((m: ReaData) => m.id === chatModel("anthropic"))) setChatModel(cfg.models[0].id, "anthropic");
    if (!cfg.providers?.some((p: ReaData) => p.id === chatState.provider)) chatState.provider = "anthropic";
    if (!cfg.agents.some((a: ReaData) => a.id === chatState.agent)) chatState.agent = cfg.agents[0].id;
    if (!cfg.efforts.includes(chatState.effort)) chatState.effort = cfg.defaultEffort;
  } catch (err) {
    chatState.configError = errorMessage(err);
  }
}

// Anthropic and OpenRouter keep the storage names they had before other providers arrived.
const storageName = (provider: string, what: string) => (provider === "anthropic" ? (what === "key" ? "rea-chat-apikey" : "rea-chat-model") : `rea-chat-${provider}-${what}`);
const chatProvider = (): ChatProvider => chatState.config?.providers?.find((p: ReaData) => p.id === chatState.provider) ?? { id: "anthropic", label: "Anthropic", keyLabel: "Anthropic API key", keyPlaceholder: "sk-ant-…", keyEnv: "ANTHROPIC_API_KEY", serverKey: chatState.config?.serverKey ?? false };
const chatKey = (provider = chatState.provider) => (chatState.keys[provider] ??= localStorage.getItem(storageName(provider, "key")) ?? "");
const hasChatKey = () => Boolean(chatKey() || chatProvider().serverKey);
const chatModel = (provider = chatState.provider) => (chatState.models[provider] ??= localStorage.getItem(storageName(provider, "model")) ?? "");
function setChatKey(value: ReaData) {
  chatState.keys[chatState.provider] = value.trim();
  localStorage.setItem(storageName(chatState.provider, "key"), chatState.keys[chatState.provider] ?? "");
}
function setChatModel(id: string, provider = chatState.provider) {
  chatState.models[provider] = id.trim();
  localStorage.setItem(storageName(provider, "model"), chatState.models[provider]);
}
// What a new chat is created with; every chat (main page and per-app) uses the same settings.
const newChatBody = (extra = {}) => ({ provider: chatState.provider, apiKey: chatKey(), model: chatModel(), ...extra });
const providerLabel = (id: string) => chatState.config?.providers?.find((p: ReaData) => p.id === id)?.label ?? id;
function modelLabel(provider: string, id: string) {
  const m = chatState.catalogs[provider]?.find((x: ReaData) => x.id === id);
  return m ? (provider === "openrouter" ? `${m.vendor} ${m.label}` : m.label) : id;
}
function chatModelLabel(session: ReaData) {
  const label = modelLabel(session.provider, session.model);
  return session.provider === "anthropic" ? label : `${label} via ${providerLabel(session.provider).replace(/ \(.*\)$/, "")}`;
}

// Strong tool-using defaults, in order. Lists are searched newest version first.
const MODEL_DEFAULTS: Record<string, RegExp[]> = {
  openrouter: [/^anthropic\/claude-sonnet-5/, /^anthropic\/claude-opus-5/, /^anthropic\/claude-sonnet/, /^openai\/gpt-5/, /^google\/gemini-.*pro/],
  openai: [/^gpt-5(\.\d+)?$/, /^gpt-5/, /^gpt-4\.1$/, /^o\d$/],
  gemini: [/^gemini-[\d.]+-pro$/, /^gemini-[\d.]+-pro/, /^gemini-[\d.]+-flash$/],
  xai: [/^grok-\d(\.\d)?$/, /^grok-\d/],
  deepseek: [/^deepseek-chat$/, /^deepseek-/],
};
const newestFirst = (a: ReaData, b: ReaData) => b.id.localeCompare(a.id, "en", { numeric: true });
async function loadModels(provider = chatState.provider, refresh = false) {
  if (provider === "anthropic") return;
  try {
    const models = (await api("/api/chat/models", { method: "POST", body: { provider, apiKey: chatKey(provider), refresh } })).models;
    chatState.catalogs[provider] = models;
    delete chatState.catalogErrors[provider];
    if (!chatModel(provider) || (models.length && !models.some((m: ReaData) => m.id === chatModel(provider)) && provider !== "openrouter")) {
      const pick = (MODEL_DEFAULTS[provider] ?? []).map((re: RegExp) => models.filter((m: ReaData) => re.test(m.id)).sort(newestFirst)[0]).find(Boolean) ?? models[0];
      if (pick || provider === "openrouter") setChatModel(pick?.id ?? "openrouter/auto", provider);
    }
  } catch (err) {
    chatState.catalogErrors[provider] = errorMessage(err);
  }
}
// Not having a key or model is reported in words the user can act on, wherever the chat is.
function chatSetupProblem() {
  if (!hasChatKey()) return `Add your ${chatProvider().keyLabel} in Chat settings to ask questions.`;
  if (!chatModel()) return "Pick a model in Chat settings.";
  return null;
}

async function loadChatSessions() {
  try {
    // Analysis chats live on their analysis page, not in the main chat list.
    chatState.sessions = (await api("/api/chat/sessions")).sessions.filter((s: ReaData) => !s.scope);
  } catch {
    chatState.sessions = [];
  }
  if (chatState.active && !chatState.sessions.some((s) => s.id === chatState.active)) setActiveChat(null);
}

function setActiveChat(id: string | null) {
  chatState.active = id;
  if (id) sessionStorage.setItem("rea-chat-active", id);
  else sessionStorage.removeItem("rea-chat-active");
}

// Minimal Markdown → DOM (no innerHTML): fenced code, headings, lists, quotes, paragraphs, inline code/bold/italic/links.
function renderInline(text: string) {
  const out = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\((https?:\/\/[^)\s]+)\))/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) out.push(h("code", { text: m[1].slice(1, -1) }));
    else if (m[2]) out.push(h("strong", { text: m[2].slice(2, -2) }));
    else if (m[3]) out.push(h("em", { text: m[3].slice(1, -1) }));
    else out.push(h("a", { href: m[5], target: "_blank", rel: "noopener noreferrer", text: (m[4] ?? "").slice(1, (m[4] ?? "").indexOf("]")) }));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function renderMarkdown(src: string) {
  const root = document.createDocumentFragment();
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  const at = (k: number): string => lines[k] ?? "";
  while (i < lines.length) {
    const line = at(i);
    if (/^```/.test(line)) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(at(i))) body.push(at(i++));
      i++;
      root.append(h("pre", { class: "md-code" }, h("code", { text: body.join("\n") })));
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      root.append(h(`h${Math.min((heading[1] ?? "").length + 2, 6)}`, {}, renderInline(heading[2] ?? "")));
      i++;
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const list = h(ordered ? "ol" : "ul");
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(at(i))) {
        list.append(h("li", {}, renderInline(at(i).replace(/^\s*([-*+]|\d+[.)])\s+/, ""))));
        i++;
      }
      root.append(list);
      continue;
    }
    if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^>\s?/.test(at(i))) quote.push(at(i++).replace(/^>\s?/, ""));
      root.append(h("blockquote", {}, renderInline(quote.join(" "))));
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && at(i).trim() && !/^(```|#{1,4}\s|>|\s*([-*+]|\d+[.)])\s)/.test(at(i))) para.push(at(i++));
    const p = h("p");
    para.forEach((l, n) => {
      if (n) p.append(h("br"));
      p.append(...renderInline(l));
    });
    root.append(p);
  }
  return root;
}

// Applies chat events to a transcript element. Streaming text re-renders once per frame.
function chatRenderer(container: HTMLElement, sessionId: string, onBusy = setChatBusy) {
  let textEl: HTMLElement | null = null;
  let textSrc = "";
  let thinkingEl: HTMLElement | null = null;
  let pending = false;
  const tools = new Map(); // tool_use id → card parts
  const scroll = () => {
    const body = container.parentElement;
    if (body && body.scrollHeight - body.scrollTop - body.clientHeight < 160) body.scrollTop = body.scrollHeight;
  };
  const flushText = () => {
    pending = false;
    if (!textEl) return;
    textEl.replaceChildren(renderMarkdown(textSrc));
    scroll();
  };
  const endBlocks = () => {
    if (textEl) flushText();
    textEl = null;
    textSrc = "";
    thinkingEl = null;
  };
  const notice = (cls: string, text: string) => {
    endBlocks();
    container.append(h("div", { class: `chat-notice ${cls}`, text }));
    scroll();
  };
  const toolCard = (id: string, name: string) => {
    let t = tools.get(id);
    if (t) return t;
    endBlocks();
    const status = h("span", { class: "pill running", text: "running" });
    const details = h("details", { class: "chat-tool" }, h("summary", {}, h("span", { class: "tool-name", text: name }), status));
    const actions = h("div", { class: "chat-tool-actions" });
    details.append(actions);
    container.append(details);
    t = { details, status, actions };
    tools.set(id, t);
    return t;
  };
  const respond = async (id: string, approved: boolean, t: ReaData) => {
    t.actions.replaceChildren(h("span", { class: "muted", text: approved ? "Approved" : "Declined" }));
    try {
      await api(`/api/chat/sessions/${sessionId}/approve`, { method: "POST", body: { toolUseId: id, approved } });
    } catch (err) {
      t.actions.replaceChildren(h("span", { class: "chat-error-text", text: errorMessage(err) }));
    }
  };

  return function apply(ev: ReaData) {
    switch (ev.type) {
      case "user":
        endBlocks();
        container.append(h("div", { class: "chat-msg user" }, h("div", { class: "chat-bubble user-bubble", text: ev.text })));
        break;
      case "text_start":
        endBlocks();
        break;
      case "text":
        if (!textEl) {
          thinkingEl = null;
          textEl = h("div", { class: "chat-bubble assistant-bubble md" });
          container.append(h("div", { class: "chat-msg assistant" }, textEl));
        }
        textSrc += ev.text;
        if (!pending) {
          pending = true;
          requestAnimationFrame(flushText);
        }
        break;
      case "thinking_start":
        endBlocks();
        break;
      case "thinking":
        if (!ev.text) break;
        if (!thinkingEl) {
          endBlocks();
          thinkingEl = h("pre", { class: "chat-thinking-text" });
          container.append(h("details", { class: "chat-thinking" }, h("summary", { text: "Thinking" }), thinkingEl));
        }
        thinkingEl.textContent += ev.text;
        break;
      case "tool_search":
        endBlocks();
        tools.set(ev.id, { line: container.appendChild(h("div", { class: "chat-notice search", text: "Searching REA tools…" })) });
        break;
      case "tool_search_query": {
        const t = tools.get(ev.id);
        const q = ev.input?.query ?? ev.input?.pattern ?? JSON.stringify(ev.input);
        if (t?.line) t.line.textContent = `Searching REA tools: ${q}`;
        break;
      }
      case "tool_search_result": {
        const t = tools.get(ev.id);
        if (t?.line) t.line.textContent += ev.tools.length ? ` → ${ev.tools.join(", ")}` : " → no matches";
        break;
      }
      case "tool_start": {
        const t = toolCard(ev.id, ev.name);
        t.details.insertBefore(h("pre", { class: "chat-tool-io", text: JSON.stringify(ev.input ?? {}, null, 2) }), t.actions);
        break;
      }
      case "approval": {
        const t = toolCard(ev.id, ev.name);
        t.details.open = true;
        t.status.className = "pill warn";
        t.status.textContent = "needs approval";
        t.actions.replaceChildren(
          h("span", { class: "muted", text: "This tool can change state. Run it?" }),
          h("button", { class: "primary small", text: "Run tool", onclick: () => respond(ev.id, true, t) }),
          h("button", { class: "ghost small", text: "Decline", onclick: () => respond(ev.id, false, t) }),
        );
        break;
      }
      case "approval_result": {
        const t = tools.get(ev.id);
        if (!t?.actions) break;
        t.actions.replaceChildren(h("span", { class: "muted", text: ev.approved ? "Approved" : "Declined" }));
        if (ev.approved) {
          t.status.className = "pill running";
          t.status.textContent = "running";
        }
        break;
      }
      case "tool_end": {
        const t = tools.get(ev.id);
        if (!t?.status) break;
        t.status.className = `pill ${ev.isError ? "error" : "done"}`;
        t.status.textContent = ev.isError ? "error" : "done";
        if (ev.result) t.details.append(h("pre", { class: "chat-tool-io result", text: ev.result }));
        break;
      }
      case "notice":
        notice("info", ev.text);
        break;
      case "error":
        notice("error", ev.message);
        break;
      case "aborted":
        notice("info", "Stopped.");
        break;
      case "turn_start":
        onBusy(true);
        break;
      case "turn_end":
        endBlocks();
        onBusy(false);
        break;
    }
    scroll();
  };
}

function setChatBusy(busy: boolean) {
  chatState.busy = busy;
  const send = document.querySelector<HTMLElement>("#chat-send");
  if (!send) return;
  send.textContent = busy ? "Stop" : "Send";
  send.classList.toggle("primary", !busy);
  send.classList.toggle("danger", busy);
  document.querySelector<HTMLElement>("#chat-typing")?.classList.toggle("hidden", !busy);
}

function connectChatStream(sessionId: string) {
  chatState.es?.close();
  const es = new EventSource(`/api/chat/sessions/${encodeURIComponent(sessionId)}/stream?token=${token}`);
  chatState.es = es;
  es.addEventListener("reset", (e) => {
    const data = JSON.parse(e.data);
    const container = document.querySelector<HTMLElement>("#chat-messages");
    if (!container) return;
    container.replaceChildren();
    chatState.view = chatRenderer(container, sessionId);
    for (const ev of data.events) chatState.view(ev);
    setChatBusy(data.busy);
    const body = container.parentElement;
    if (body) body.scrollTop = body.scrollHeight;
  });
  es.addEventListener("chat", (e) => {
    const ev = JSON.parse(e.data);
    chatState.view?.(ev);
    if (ev.type === "turn_end") loadChatSessions().then(renderChatList);
  });
  es.onerror = () => {
    // The session is gone (server restarted): stop reconnecting.
    if (es.readyState === EventSource.CLOSED) return;
    api("/api/chat/sessions").then(({ sessions }) => {
      if (!sessions.some((s: ReaData) => s.id === sessionId)) {
        es.close();
        setActiveChat(null);
        renderChat();
      }
    }).catch(() => {});
  };
}

function renderChatList() {
  const list = document.querySelector<HTMLElement>("#chat-list");
  if (!list) return;
  list.replaceChildren(
    h("button", {
      class: `chat-list-item new ${chatState.active ? "" : "active"}`,
      text: "New chat",
      onclick: () => {
        chatState.es?.close();
        setActiveChat(null);
        renderChat();
      },
    }),
    ...chatState.sessions.map((s) =>
      h(
        "div",
        { class: `chat-list-row ${s.id === chatState.active ? "active" : ""}` },
        h("button", {
          class: "chat-list-item",
          title: `${chatModelLabel(s)} · ${s.agent}`,
          text: `${s.busy ? "◌ " : ""}${s.title ?? "Untitled chat"}`,
          onclick: () => {
            setActiveChat(s.id);
            renderChat();
          },
        }),
        h("button", {
          class: "ghost small chat-delete",
          title: "Delete chat",
          "aria-label": "Delete chat",
          text: "✕",
          onclick: async () => {
            await api(`/api/chat/sessions/${encodeURIComponent(s.id)}`, { method: "DELETE" }).catch(() => {});
            if (s.id === chatState.active) {
              chatState.es?.close();
              setActiveChat(null);
            }
            renderChat();
          },
        }),
      ),
    ),
  );
}

async function renderChat(): Promise<void> {
  // Redraws (provider switch, model list arriving, REA's tools loading) keep the half-typed message.
  const draft = document.querySelector<HTMLInputElement>("#chat-prompt")?.value ?? "";
  if (!chatState.config) {
    setMain(h("div", { class: "empty", text: "Loading chat…" }));
    await loadChatConfig();
    if (location.hash !== "#/chat") return;
    if (!chatState.config) {
      return setMain(
        h(
          "div",
          { class: "empty" },
          h("p", { text: `Couldn't load chat settings: ${chatState.configError}` }),
          h("p", {
            class: "muted",
            text: "If you just updated REA GUI, the web server is still running the old code. Stop it (Ctrl+C in its terminal) and run npm start again, then reload this page. The Restart REA button only restarts REA's tools, not this server.",
          }),
          h("button", { class: "primary", text: "Try again", onclick: () => renderChat() }),
        ),
      );
    }
  }
  await loadChatSessions();
  if (location.hash !== "#/chat") return;
  const cfg = chatState.config;
  const active = chatState.sessions.find((s) => s.id === chatState.active);

  const prompt = h("textarea", {
    class: "chat-prompt",
    id: "chat-prompt",
    rows: 2,
    placeholder: "Ask about an app or binary, e.g. “Open /Applications/Slack.app and summarize its Electron security settings”",
    onkeydown: (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        if (!chatState.busy) sendChatMessage();
      }
    },
  });
  prompt.value = draft;
  const effortSelect = h(
    "select",
    { "aria-label": "Effort", onchange: (e) => localStorage.setItem("rea-chat-effort", (chatState.effort = e.target.value)) },
    ...cfg.efforts.map((e: ReaData) => h("option", { value: e, text: e, selected: e === chatState.effort })),
  );
  const composer = h(
    "div",
    { class: "chat-composer" },
    prompt,
    h(
      "div",
      { class: "chat-composer-bar" },
      h("label", { class: "chat-label" }, "Effort", effortSelect),
      h("span", { class: "muted hidden", id: "chat-typing", text: "Working…" }),
      h("span", { class: "spacer" }),
      h("button", {
        class: "primary",
        id: "chat-send",
        text: "Send",
        onclick: () => (chatState.busy ? api(`/api/chat/sessions/${encodeURIComponent(chatState.active ?? "")}/abort`, { method: "POST" }).catch(() => {}) : sendChatMessage()),
      }),
    ),
  );

  let top;
  if (active) {
    const agent = cfg.agents.find((a: ReaData) => a.id === active.agent);
    top = h("div", { class: "chat-header" }, h("h1", { text: active.title ?? "Chat" }), h("p", { class: "muted", text: `${agent?.label ?? active.agent} · ${chatModelLabel(active)}` }));
  } else {
    top = h(
      "div",
      { class: "chat-header" },
      h("h1", { text: "Chat with REA" }),
      h("p", { class: "muted", text: "Describe what you want to know. The assistant finds and runs the right REA tools and asks before running anything that changes state." }),
      chatSettings(cfg),
    );
  }

  setMain(
    h(
      "div",
      { class: "chat-layout" },
      h("nav", { class: "chat-list", id: "chat-list", "aria-label": "Chats" }),
      h("div", { class: "chat-panel" }, top, h("div", { class: "chat-body" }, h("div", { class: "chat-messages", id: "chat-messages" })), composer),
    ),
  );
  renderChatList();
  setChatBusy(Boolean(active?.busy));
  if (active) connectChatStream(active.id);
  else chatState.es?.close();
  prompt.focus();
}

// Provider, key, model and assistant for new chats. Existing chats keep the settings they started with.
// Once a key is saved, it folds into a one-line summary.
function chatSettings(cfg: ReaData) {
  const provider = chatProvider();
  const rerender = () => location.hash === "#/chat" && !chatState.active && renderChat();
  const providerSelect = h(
    "select",
    {
      id: "chat-provider",
      onchange: (e) => {
        localStorage.setItem("rea-chat-provider", (chatState.provider = e.target.value));
        chatState.settingsOpen = true;
        renderChat();
      },
    },
    ...cfg.providers.map((p: ReaData) => h("option", { value: p.id, text: p.label, selected: p.id === chatState.provider })),
  );
  const keyInput = h("input", {
    type: "password",
    id: "chat-key",
    autocomplete: "off",
    placeholder: provider.serverKey ? `Using ${provider.keyEnv} from the server` : provider.keyPlaceholder,
    value: chatKey(),
    onchange: (e) => {
      setChatKey(e.target.value);
      // A new key unlocks the provider's model list; with a key and a model, the settings fold away.
      if (chatState.provider !== "anthropic") delete chatState.catalogs[chatState.provider], delete chatState.catalogErrors[chatState.provider];
      if (chatKey()) chatState.settingsOpen = false;
      (chatState.provider === "anthropic" ? Promise.resolve() : loadModels()).then(() => void rerender());
    },
  });
  const keyHelp = h(
    "small",
    { class: "muted" },
    ...(provider.keyUrl ? ["Create one at ", h("a", { href: provider.keyUrl, target: "_blank", rel: "noopener", text: new URL(provider.keyUrl).host }), ". "] : []),
    "Stored in this browser only and sent to your REA GUI server.",
  );
  const agentSelect = h(
    "select",
    { id: "chat-agent", onchange: (e) => localStorage.setItem("rea-chat-agent", (chatState.agent = e.target.value)) },
    ...cfg.agents.map((a: ReaData) => h("option", { value: a.id, text: a.label, title: a.description, selected: a.id === chatState.agent })),
  );
  const open = chatState.settingsOpen ?? !hasChatKey();
  const box = h(
    "details",
    { class: "chat-settings-box", open },
    h(
      "summary",
      { class: "chat-settings-summary" },
      h("span", { class: "grow" }, h("strong", { text: provider.label.replace(/ \(.*\)$/, "") }), " · ", chatModel() ? modelLabel(chatState.provider, chatModel()) : "No model chosen", " · ", cfg.agents.find((a: ReaData) => a.id === chatState.agent)?.label ?? ""),
      h("span", { class: `badge ${hasChatKey() ? "" : "warn"}`, text: hasChatKey() ? (chatKey() ? "Key saved" : "Server key") : "Needs a key" }),
      h("span", { class: "chat-settings-toggle", text: open ? "Hide" : "Change" }),
    ),
    h(
      "div",
      { class: "chat-settings" },
      h("label", { class: "chat-field" }, h("span", { text: "Provider" }), providerSelect),
      h("label", { class: "chat-field" }, h("span", { text: provider.keyLabel }), keyInput, keyHelp),
      ...modelFields(cfg),
      h("label", { class: "chat-field" }, h("span", { text: "Assistant" }), agentSelect),
      h(
        "div",
        { class: "chat-settings-actions" },
        h("button", {
          class: "primary",
          type: "button",
          text: "Save",
          onclick: () => {
            // Fields save as they change; this commits anything still being typed and folds the settings.
            const key = document.querySelector<HTMLInputElement>("#chat-key");
            if (key && key.value.trim() !== chatKey()) setChatKey(key.value);
            const typed = document.querySelector<HTMLInputElement>("#chat-model");
            if (typed?.tagName === "INPUT" && typed.value.trim()) setChatModel(typed.value);
            chatState.settingsOpen = !hasChatKey();
            if (chatState.provider !== "anthropic" && !chatState.catalogs[chatState.provider]) delete chatState.catalogErrors[chatState.provider];
            (chatState.provider === "anthropic" || chatState.catalogs[chatState.provider] ? Promise.resolve() : loadModels()).then(renderChat);
          },
        }),
      ),
    ),
  );
  box.addEventListener("toggle", () => {
    chatState.settingsOpen = box.open;
    box.querySelector(".chat-settings-toggle")!.textContent = box.open ? "Hide" : "Change";
  });
  return box;
}

// The model picker for the current provider. OpenRouter's hundreds of models are split by maker.
function modelFields(cfg: ReaData) {
  const id = chatState.provider;
  const field = (label: string, ...children: Child[]) => h("label", { class: "chat-field" }, h("span", { text: label }), ...children);
  const choose = (value: ReaData) => {
    setChatModel(value);
    document.querySelector(".chat-settings-summary .grow")?.replaceChildren(h("strong", { text: chatProvider().label.replace(/ \(.*\)$/, "") }), " · ", modelLabel(id, value), " · ", cfg.agents.find((a: ReaData) => a.id === chatState.agent)?.label ?? "");
  };
  if (id === "anthropic") {
    return [field("Model", h("select", { id: "chat-model", onchange: (e) => choose(e.target.value) }, ...cfg.models.map((m: ReaData) => h("option", { value: m.id, text: m.label, title: m.note, selected: m.id === chatModel() }))))];
  }
  const models = chatState.catalogs[id];
  const error = chatState.catalogErrors[id];
  if (!models && !error) {
    if (!hasChatKey() && id !== "openrouter") return [field("Model", h("input", { disabled: true, placeholder: "Add your key to see models" }))];
    loadModels().then(() => void (location.hash === "#/chat" && !chatState.active && renderChat()));
    return [field("Model", h("input", { disabled: true, placeholder: `Loading ${chatProvider().label.replace(/ \(.*\)$/, "")} models…` }))];
  }
  if (error || !models?.length) {
    const input = h("input", { id: "chat-model", value: chatModel(), spellcheck: false, placeholder: id === "openrouter" ? "e.g. anthropic/claude-sonnet-5.5" : "Model ID", onchange: (e) => choose(e.target.value) });
    return [field("Model", input, h("small", { class: "chat-error-text" }, `${error ?? "No chat models found for this key."} You can still type a model ID. `, h("button", { class: "link", type: "button", text: "Try again", onclick: () => (delete chatState.catalogErrors[id], delete chatState.catalogs[id], renderChat()) })))];
  }
  if (id !== "openrouter") {
    const current = chatModel();
    const options = models.some((m: ReaData) => m.id === current) ? models : [{ id: current, label: current }, ...models];
    return [field("Model", h("select", { id: "chat-model", onchange: (e) => choose(e.target.value) }, ...options.map((m: ReaData) => h("option", { value: m.id, text: m.label, selected: m.id === current }))))];
  }

  // OpenRouter: pick the maker, then the model; the price and context size show underneath.
  const vendors = [...new Set(models.map((m: ReaData) => m.vendor))];
  const counts = Object.fromEntries(vendors.map((v) => [v, models.filter((m: ReaData) => m.vendor === v).length]));
  const current = models.find((m: ReaData) => m.id === chatModel());
  let vendor = current?.vendor ?? vendors[0];
  const note = h("small", { class: "muted" });
  const describe = () => {
    const m = models.find((x: ReaData) => x.id === chatModel());
    note.textContent = m ? [m.id, m.note, m.reasoning ? "supports reasoning" : null].filter(Boolean).join(" · ") : `${chatModel()} isn't in OpenRouter's list of tool-capable models; chats may fail.`;
  };
  const modelSelect = h("select", { id: "chat-model", onchange: (e) => (choose(e.target.value), describe()) });
  const fillModels = () => {
    const list = models.filter((m: ReaData) => m.vendor === vendor);
    if (!list.some((m: ReaData) => m.id === chatModel())) {
      // Switching maker picks its newest strong model, or its first.
      const pick = (MODEL_DEFAULTS.openrouter ?? []).map((re) => list.filter((m: ReaData) => re.test(m.id)).sort(newestFirst)[0]).find(Boolean) ?? list[0];
      if (pick) choose(pick.id);
    }
    modelSelect.replaceChildren(...list.map((m: ReaData) => h("option", { value: m.id, text: m.label, selected: m.id === chatModel() })));
    describe();
  };
  const vendorSelect = h(
    "select",
    { id: "chat-vendor", onchange: (e) => ((vendor = e.target.value), fillModels()) },
    ...(current ? [] : [h("option", { value: "", text: "Choose a maker", selected: true, disabled: true })]),
    ...vendors.map((v) => h("option", { value: v, text: `${v} (${counts[v]})`, selected: v === current?.vendor })),
  );
  if (current) fillModels();
  else {
    modelSelect.append(h("option", { value: chatModel(), text: chatModel() || "Choose a model", selected: true }));
    describe();
  }
  return [field("Model maker", vendorSelect, h("small", { class: "muted", text: `${models.length} tool-capable models on OpenRouter.` })), field("Model", modelSelect, note)];
}

async function sendChatMessage() {
  const prompt = document.querySelector<HTMLInputElement>("#chat-prompt");
  const text = prompt?.value.trim();
  const cfg = chatState.config;
  if (!prompt || !text || !cfg) return;
  const showError = (message: string) => {
    document.querySelector<HTMLElement>("#chat-messages")?.append(h("div", { class: "chat-notice error", text: message }));
  };

  if (!chatState.active) {
    // The model field commits on change; read it directly in case it still has focus.
    const typed = document.querySelector<HTMLInputElement>("#chat-model")?.value?.trim();
    if (typed && typed !== chatModel()) setChatModel(typed);
    const keyField = document.querySelector<HTMLInputElement>("#chat-key");
    if (keyField && keyField.value.trim() !== chatKey()) setChatKey(keyField.value);
    const problem = chatSetupProblem();
    if (problem) {
      showError(problem);
      document.querySelector(".chat-settings-box")?.setAttribute("open", "");
      return document.getElementById(hasChatKey() ? "chat-model" : "chat-key")?.focus();
    }
    const agent = cfg.agents.find((a: ReaData) => a.id === chatState.agent);
    if (agent?.usesRea && state.status?.state !== "ready") return showError("REA isn't running yet. Wait for it to start, or restart it from the top bar.");
    try {
      const sess = await api("/api/chat/sessions", { method: "POST", body: newChatBody({ agent: chatState.agent }) });
      setActiveChat(sess.id);
      prompt.value = "";
      await renderChat(); // switches to the session view and opens its stream
    } catch (err) {
      return showError(errorMessage(err));
    }
  } else {
    prompt.value = "";
  }
  try {
    setChatBusy(true);
    await api(`/api/chat/sessions/${encodeURIComponent(chatState.active ?? "")}/message`, { method: "POST", body: { message: text, effort: chatState.effort } });
  } catch (err) {
    setChatBusy(false);
    // The chat may have been redrawn, so put the message back in the current box.
    const field = document.querySelector<HTMLInputElement>("#chat-prompt");
    if (field) field.value = text;
    showError(errorMessage(err));
  }
}

// Below the sidebar breakpoint the sidebar is a drawer opened from the top bar.
const sidebarQuery = matchMedia("(max-width: 900px)");
function setSidebarOpen(open: boolean) {
  document.body.classList.toggle("sidebar-open", open);
  $("#sidebar-toggle").setAttribute("aria-expanded", String(open));
  $("#sidebar-backdrop").hidden = !open;
}
$("#sidebar-toggle").addEventListener("click", () => setSidebarOpen(!document.body.classList.contains("sidebar-open")));
$("#sidebar-backdrop").addEventListener("click", () => setSidebarOpen(false));
document.addEventListener("keydown", (e) => e.key === "Escape" && setSidebarOpen(false));
sidebarQuery.addEventListener("change", () => setSidebarOpen(false));
window.addEventListener("hashchange", () => sidebarQuery.matches && setSidebarOpen(false));

window.addEventListener("hashchange", () => route());

renderHistory();
renderAnalysisList();
route();
connectEvents();
