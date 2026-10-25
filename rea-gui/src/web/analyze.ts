// Guided analysis: detect what a path is, run the matching REA checks in order, and explain
// each result in plain language. Full REA output stays one click away under "Details".
import { exploreFor } from "/evidence.js";
import type { CallRecord, EvidenceContext, H, ReaData, StartCall } from "/dom.js";

/** What the guided analysis needs from the app. */
export interface AnalysisDeps {
  h: H;
  startCall: StartCall;
  cancelCall: (callId: string) => Promise<unknown>;
  renderResult: (container: HTMLElement, record: CallRecord) => void;
  evidenceCtx: (drills: HTMLElement) => EvidenceContext;
  toolExists: (name: string) => boolean;
  availabilityOf: (name: string) => { available?: boolean; reason?: string; remediation?: string } | null;
  iconUrl: (path: string) => string;
  onChange: (analysis: Analysis) => void;
  rerun: (path: string) => void;
  remove: (analysis: Analysis) => void;
  reaSession: () => string | null;
}

/** A finding: its tone ("warn", "good" or "info") and text. */
type Finding = [string, string];
type Fact = [string, unknown];
interface Summary {
  headline: string;
  facts: Fact[];
  findings: Finding[];
  explore?: boolean;
}

/** What a check's run() gets: REA calls scoped to this analysis. */
interface StepContext {
  h: H;
  kind: string;
  path: string;
  detected: ReaData;
  opened: boolean;
  toolExists: (name: string) => boolean;
  parse: (record: CallRecord | null) => ReaData;
  progress: (text: string) => void;
  call: (name: string, args: ReaData) => Promise<CallRecord>;
  ensureOpen: () => Promise<CallRecord | null>;
}

interface Step {
  id: string;
  title: string;
  why: string;
  tools: string[];
  slow?: boolean;
  run(ctx: StepContext): Promise<CallRecord | null>;
  summarize(parsed: ReaData, record: CallRecord): Summary;
}

type Availability = { available?: boolean; reason?: string; remediation?: string };
/** How one check ended; saved with the analysis. */
export interface StepEntry {
  id: string;
  status: "done" | "failed" | "skipped" | "locked";
  record?: CallRecord | null;
  message?: string;
  availability?: Availability;
}

export interface Analysis {
  id: string;
  path: string;
  name: string;
  kind: string;
  detected: ReaData;
  at: number;
  finishedAt: number | null;
  state: "running" | "done" | "stopped" | "interrupted";
  reaSession: string | null;
  steps: StepEntry[];
  results: { check: string; headline: string; facts: Fact[]; findings: string[] }[];
  /** The rendered page, while this tab has it open. */
  page: HTMLElement | null;
  waiting?: boolean;
  failedChecks?: number;
}

// ---------- what a path is ----------
export const KINDS: Record<string, { label: string; blurb: string }> = {
  electron: { label: "Electron app", blurb: "A desktop app built with web technology. REA checks its signature, Electron hardening, bundle layout and JavaScript code." },
  "mac-app": { label: "Mac app", blurb: "A native macOS app. REA checks its signature and entitlements, the main executable and the bundle layout." },
  android: { label: "Android app", blurb: "An Android package. REA maps its manifest, code, native libraries and signing, and checks for Flutter." },
  ios: { label: "iOS app", blurb: "An iPhone/iPad package. REA maps its bundles, executables, frameworks and signing." },
  js: { label: "JavaScript app", blurb: "JavaScript sources or an app.asar. REA reconstructs the module graph, Electron IPC, exposed APIs and network endpoints." },
  windows: { label: "Windows program", blurb: "A Windows EXE or DLL. REA reads its resources and, for .NET assemblies, its managed metadata." },
  "mach-o": { label: "Mac binary", blurb: "A Mach-O executable or library. REA reads its architecture, linked libraries and signature." },
  elf: { label: "Linux binary", blurb: "An ELF executable or library. REA opens it and inventories it." },
  wasm: { label: "WebAssembly module", blurb: "A WebAssembly module. REA validates it and lists its imports and exports." },
  sqlite: { label: "SQLite database", blurb: "A SQLite database. REA reads its schema without modifying it." },
  archive: { label: "Archive or package", blurb: "REA inventories every file inside it." },
};

export function classify(d: ReaData) {
  if (!d?.exists) return null;
  const ext = (d.name.match(/\.[^.]+$/)?.[0] ?? "").toLowerCase();
  if (d.dir) {
    if (d.electronAsar) return "electron";
    if (d.bundle) return "mac-app";
    if (d.packageJson) return "js";
    return null;
  }
  if ([".apk", ".aab", ".apks", ".xapk", ".apkm"].includes(ext)) return "android";
  if (ext === ".ipa") return "ios";
  if (ext === ".asar") return "js";
  if (d.magic === "mach-o") return "mach-o";
  if (d.magic === "elf") return "elf";
  if (d.magic === "pe") return "windows";
  if (d.magic === "wasm") return "wasm";
  if (d.magic === "sqlite") return "sqlite";
  return "archive";
}

// ---------- plain-language tables ----------
const ENTITLEMENTS: Record<string, Finding> = {
  "com.apple.security.app-sandbox": ["good", "Runs in the App Sandbox"],
  "com.apple.security.cs.disable-library-validation": ["warn", "Can load libraries not signed by its developer"],
  "com.apple.security.cs.allow-dyld-environment-variables": ["warn", "Honors DYLD_* variables, so libraries can be injected at launch"],
  "com.apple.security.cs.allow-unsigned-executable-memory": ["warn", "Allows unsigned executable memory"],
  "com.apple.security.get-task-allow": ["warn", "Other processes can attach a debugger"],
  "com.apple.security.cs.debugger": ["warn", "Can debug other processes"],
  "com.apple.security.cs.allow-jit": ["info", "Allows JIT-compiled code"],
  "com.apple.security.device.camera": ["info", "Can ask for camera access"],
  "com.apple.security.device.audio-input": ["info", "Can ask for microphone access"],
  "com.apple.security.device.microphone": ["info", "Can ask for microphone access"],
  "com.apple.security.personal-information.location": ["info", "Can ask for location access"],
  "com.apple.security.personal-information.addressbook": ["info", "Can ask for contacts access"],
  "com.apple.security.personal-information.calendars": ["info", "Can ask for calendar access"],
  "com.apple.security.personal-information.photos-library": ["info", "Can ask for Photos library access"],
  "com.apple.security.automation.apple-events": ["info", "Can ask to control other apps (Apple Events)"],
};

// Electron fuse → [tone, meaning] when enabled and when disabled.
const FUSES: Record<string, [Finding, Finding]> = {
  RunAsNode: [["warn", "ELECTRON_RUN_AS_NODE works: the app's binary can run any Node.js script"], ["good", "Can't be started as a plain Node.js runtime"]],
  EnableNodeOptionsEnvironmentVariable: [["warn", "NODE_OPTIONS is honored, so code can be injected through the environment"], ["good", "Ignores NODE_OPTIONS"]],
  EnableNodeCliInspectArguments: [["warn", "--inspect flags are honored, so a debugger can attach to the main process"], ["good", "Ignores --inspect debugging flags"]],
  EnableEmbeddedAsarIntegrityValidation: [["good", "App code (app.asar) is integrity-checked at startup"], ["warn", "App code (app.asar) isn't integrity-checked, so it can be modified on disk"]],
  OnlyLoadAppFromAsar: [["good", "Only loads app code from app.asar"], ["warn", "Can load app code from outside app.asar"]],
  EnableCookieEncryption: [["good", "Cookies are encrypted on disk"], ["info", "Electron doesn't encrypt cookies on disk"]],
  GrantFileProtocolExtraPrivileges: [["info", "file:// pages get extra privileges"], ["good", "file:// pages get no extra privileges"]],
};

// "Developer ID Application: Whimsical Incorporated (2N6497CB83)" → "Whimsical Incorporated".
const signer = (s: ReaData) => s.authorities?.[0]?.replace(/^[^:]+:\s*/, "").replace(/\s*\([A-Z0-9]+\)$/, "") || s.team_identifier || "unknown signer";
const elapsed = (since: number) => {
  const secs = Math.round((Date.now() - since) / 1000);
  return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, "0")}s`;
};
const n = (v: ReaData) => (typeof v === "number" ? v.toLocaleString() : v ?? "—");
const plural = (count: number, word: string, many = `${word}s`) => `${n(count)} ${count === 1 ? word : many}`;
const fileName = (path: string) => path.replace(/\/+$/, "").split("/").pop();

// ---------- recipes ----------
// Each step: { id, title, why, tools (all must exist), run(ctx) -> record, summarize(parsed, ctx) -> { facts, findings, headline } }.
const steps: Record<string, Step> = {
  signature: {
    id: "signature",
    title: "Code signature",
    why: "Who signed it, and what macOS permissions (entitlements) it asks for.",
    tools: ["open_binary", "inspect_signature"],
    async run(ctx: StepContext) {
      const opened = await ctx.ensureOpen();
      if (opened) return opened;
      return ctx.call("inspect_signature", {});
    },
    summarize(ev: ReaData) {
      const s = ev.normalized_result ?? {};
      const findings: Finding[] = [];
      if (!s.signed) findings.push(["warn", "Not code-signed"]);
      else {
        findings.push(["good", `Signed by ${s.authorities?.[0] ?? s.team_identifier ?? "an unknown authority"}`]);
        if (s.hardened_runtime) findings.push(["good", "Hardened runtime is on"]);
        else findings.push(["warn", "Hardened runtime is off"]);
      }
      const seen = new Set();
      for (const [key, value] of Object.entries(s.entitlements ?? {})) {
        const meaning = value === true && ENTITLEMENTS[key];
        if (meaning && !seen.has(meaning[1])) {
          seen.add(meaning[1]);
          findings.push(meaning);
        }
      }
      return {
        headline: s.signed ? `Signed by ${signer(s)}` : "Unsigned",
        facts: [
          ["Identifier", s.identifier],
          ["Team", s.team_identifier],
          ["Signed", s.timestamp],
          ["Entitlements", Object.keys(s.entitlements ?? {}).length],
        ],
        findings,
      };
    },
  },

  fuses: {
    id: "fuses",
    title: "Electron hardening",
    why: "Fuses are on/off switches built into Electron. They decide whether the app can be repurposed, debugged or modified.",
    tools: ["inspect_electron_fuses"],
    run: (ctx: StepContext) => ctx.call("inspect_electron_fuses", { path: ctx.path }),
    summarize(ev: ReaData) {
      const fuses = ev.normalized_result?.slices?.[0]?.sentinels?.[0]?.fuses ?? [];
      const findings: Finding[] = [];
      for (const fuse of fuses) {
        const meaning = FUSES[fuse.name]?.[fuse.state === "enabled" ? 0 : 1];
        if (meaning) findings.push(meaning);
      }
      const weak = findings.filter(([tone]) => tone === "warn").length;
      return {
        headline: fuses.length ? (weak ? `${plural(weak, "weak setting")}` : "Fully hardened") : "No fuses found",
        facts: [],
        findings: findings.sort((a, b) => order(a[0]) - order(b[0])),
      };
    },
  },

  macho: {
    id: "macho",
    title: "Main executable",
    why: "Architecture, linked libraries and imports of the Mach-O binary.",
    tools: ["open_binary", "inspect_macho"],
    async run(ctx: StepContext) {
      const opened = await ctx.ensureOpen();
      if (opened) return opened;
      return ctx.call("inspect_macho", { detail: "summary" });
    },
    summarize(ev: ReaData) {
      const s = ev.normalized_result?.summary ?? {};
      const c = s.collections ?? {};
      const count = (k: string) => c[k]?.total ?? c[k]?.returned;
      return {
        headline: `${s.selected_architecture?.name ?? ""} · ${plural(count("dependencies") ?? 0, "linked library", "linked libraries")}`,
        facts: [
          ["Architecture", s.selected_architecture?.name],
          ["Linked libraries", count("dependencies")],
          ["Imports", c.imports ? `${n(c.imports.returned)}${c.imports.exhaustive ? "" : "+"}` : null],
          ["Exports", c.exports ? `${n(c.exports.returned)}${c.exports.exhaustive ? "" : "+"}` : null],
          ["Segments", count("segments")],
          ["UUID", s.uuid],
        ],
        findings: [],
        explore: true,
      };
    },
  },

  structure: {
    id: "structure",
    title: "What's inside",
    why: "Every file in the package, sorted into code, native libraries, frameworks, resources and signing.",
    tools: ["open_binary", "inspect_artifact"],
    async run(ctx: StepContext) {
      const opened = await ctx.ensureOpen();
      if (opened) return opened;
      ctx.progress("Listing every file…");
      // Signed bundles often differ from unpacked copies; record mismatches instead of stopping.
      const inspected = await ctx.call("inspect_artifact", { integrity_policy: "record-and-continue" });
      const parsed = ctx.parse(inspected);
      const inventory = parsed?.normalized_result?.substeps?.find((s: ReaData) => s.operation === "inventory_artifact")?.evidence;
      const projection = ctx.kind === "android" ? "project_android_application_graph" : ["ios", "mac-app", "electron"].includes(ctx.kind) ? "project_apple_application_graph" : null;
      if (!inventory || !projection || !ctx.toolExists(projection)) return inspected;
      ctx.progress("Sorting files by role…");
      const graph = await ctx.call(projection, { inventory_evidence: [inventory] });
      graph.inventory = parsed;
      return graph;
    },
    summarize(ev: ReaData, record: CallRecord): Summary {
      const nr = ev.normalized_result ?? {};
      if (!nr.components) {
        const manifest = nr.observations?.find((o: ReaData) => o.kind === "root-manifest")?.value;
        return { headline: manifest ? plural(manifest.node_count, "file") : "Inventoried", facts: manifest ? [["Files", manifest.node_count], ["Relations", manifest.edge_count]] : [], findings: [] };
      }
      const c = nr.components;
      const len = (k: string) => c[k]?.length ?? 0;
      const files = record.inventory?.normalized_result?.observations?.find((o: ReaData) => o.kind === "root-manifest")?.value?.node_count;
      const runtimes = (nr.runtime_families ?? []).map((r: ReaData) => RUNTIMES[r] ?? r);
      const findings: Finding[] = runtimes.length ? [["info", `Runs on: ${runtimes.join(", ")}`]] : [];
      if (nr.root_format === "apk" && nr.bridge_candidates?.length) findings.push(["info", `${plural(nr.bridge_candidates.length, "link")} between managed code and native libraries`]);
      if (len("privileged_helpers")) findings.push(["warn", `${plural(len("privileged_helpers"), "privileged helper")} (runs as root)`]);
      if (len("launchd_plists")) findings.push(["info", `${plural(len("launchd_plists"), "launch agent/daemon", "launch agents/daemons")}`]);
      if (c.signing && !len("signing")) findings.push(["warn", "No signing files found"]);
      const facts: Fact[] = [["Files", files]];
      for (const [key, list] of Object.entries(c)) if (Array.isArray(list) && list.length) facts.push([COMPONENTS[key] ?? key.replace(/_/g, " "), list.length]);
      return { headline: [files != null ? plural(files, "file") : null, runtimes.join(" + ")].filter(Boolean).join(" · "), facts, findings };
    },
  },

  javascript: {
    id: "javascript",
    title: "JavaScript code",
    why: "Windows, preload scripts, APIs exposed to web pages, network endpoints and IPC channels (messages between web pages and the app's main process).",
    slow: true,
    tools: ["analyze_javascript_application"],
    run: (ctx: StepContext) => ctx.call("analyze_javascript_application", { input_path: ctx.detected.electronAsar ?? ctx.path, detail: "summary", integrity_policy: "record-and-continue" }),
    summarize(ev: ReaData) {
      const s = ev.normalized_result?.summary ?? {};
      const st = s.statistics ?? {};
      const e = s.electron;
      const findings: Finding[] = [];
      if (e) {
        if (e.context_bridge_apis) findings.push(["info", `Exposes ${plural(e.exposed_api_members, "function")} to web pages through ${plural(e.context_bridge_apis, "contextBridge API")}`]);
        if (e.ipc?.literal_channels) findings.push(["info", `${plural(e.ipc.literal_channels, "IPC channel")} between web pages and the main process (${n(e.ipc.main_handlers)} main-process handlers)`]);
        if (e.ipc?.dynamic_channel_operations) findings.push(["info", `${plural(e.ipc.dynamic_channel_operations, "IPC call")} with a channel name computed at runtime`]);
        if (e.native_addon_bindings) findings.push(["info", `Loads ${plural(e.native_addon_bindings, "native addon")}`]);
        if (e.utility_processes) findings.push(["info", `Starts ${plural(e.utility_processes, "utility process", "utility processes")}`]);
        if (e.ipc?.literal_channels && !e.sender_validation_observations) findings.push(["warn", "No IPC sender validation was observed"]);
      }
      if (st.parse_failures) findings.push(["warn", `${plural(st.parse_failures, "file")} couldn't be parsed`]);
      const partial = s.coverage?.application?.status && s.coverage.application.status !== "complete";
      if (partial) findings.push(["info", "Coverage is partial; see Limitations in Details"]);
      return {
        headline: e ? `${plural(e.browser_windows, "window")} · ${plural(e.ipc?.literal_channels ?? 0, "IPC channel")} · ${plural(e.exposed_api_members ?? 0, "exposed function")}` : plural(st.parsed_javascript_files ?? 0, "JavaScript file"),
        facts: [
          ["JavaScript files", st.parsed_javascript_files],
          ["Windows", e?.browser_windows],
          ["Preload scripts", e?.preload_entrypoints],
          ["IPC channels", e?.ipc?.literal_channels],
          ["Exposed functions", e?.exposed_api_members],
          ["Native addons", e?.native_addon_bindings],
        ],
        findings,
        explore: true,
      };
    },
  },

  flutter: {
    id: "flutter",
    title: "Flutter",
    why: "Whether the app is built with Flutter, and which Dart build it ships.",
    tools: ["identify_flutter_build"],
    run: (ctx: StepContext) => ctx.call("identify_flutter_build", { path: ctx.path }),
    summarize(ev: ReaData) {
      const nr = ev.normalized_result ?? {};
      const abis = nr.abis ?? [];
      const engine = abis.some((a: ReaData) => a.libflutter?.present);
      const snapshot = abis.find((a: ReaData) => a.libapp?.snapshot_hash)?.libapp?.snapshot_hash;
      const dart = abis.find((a: ReaData) => a.libflutter?.dart_version)?.libflutter?.dart_version;
      const findings: Finding[] = [];
      if (nr.flutter_detected) findings.push(["info", `Flutter app${dart ? ` (Dart ${dart})` : ""}`]);
      else if (engine) findings.push(["info", "Flutter engine present but no compiled Dart code: this looks like a debug build"]);
      else findings.push(["info", "Not a Flutter app"]);
      return {
        headline: nr.flutter_detected ? "Flutter app" : engine ? "Flutter (debug build)" : "Not Flutter",
        facts: [["CPU architectures", abis.map((a: ReaData) => a.abi).join(", ")], ["Dart version", dart], ["Snapshot hash", snapshot]],
        findings,
      };
    },
  },

  androidPackage: {
    id: "androidPackage",
    title: "Manifest & permissions",
    why: "Package name, SDK levels, permissions and components from the decoded manifest.",
    tools: ["inspect_android_package"],
    run: (ctx: StepContext) => ctx.call("inspect_android_package", { path: ctx.path, detail: "summary" }),
    summarize: (ev: ReaData) => ({ headline: "Decoded", facts: [], findings: [], explore: true }),
  },

  managed: {
    id: "managed",
    title: ".NET metadata",
    why: "Assemblies, types and members, if this is a .NET program.",
    tools: ["inspect_managed_artifact"],
    run: (ctx: StepContext) => ctx.call("inspect_managed_artifact", { path: ctx.path, detail: "summary" }),
    summarize: () => ({ headline: ".NET assembly", facts: [], findings: [], explore: true }),
  },

  peResources: {
    id: "peResources",
    title: "Windows resources",
    why: "Version info, icons, manifests and other embedded resources.",
    tools: ["inspect_pe_resources"],
    run: (ctx: StepContext) => ctx.call("inspect_pe_resources", { path: ctx.path }),
    summarize: () => ({ headline: "Read", facts: [], findings: [] }),
  },

  wasm: {
    id: "wasm",
    title: "WebAssembly module",
    why: "Sections, imports and exports.",
    tools: ["inspect_wasm_artifact"],
    run: (ctx: StepContext) => ctx.call("inspect_wasm_artifact", { path: ctx.path }),
    summarize: () => ({ headline: "Validated", facts: [], findings: [], explore: true }),
  },

  sqlite: {
    id: "sqlite",
    title: "Database schema",
    why: "Tables, columns and row counts, read without modifying the file.",
    tools: ["inspect_sqlite_database"],
    run: (ctx: StepContext) => ctx.call("inspect_sqlite_database", { path: ctx.path }),
    summarize: () => ({ headline: "Read", facts: [], findings: [] }),
  },
};

const RECIPES: Record<string, string[]> = {
  electron: ["signature", "fuses", "structure", "javascript"],
  "mac-app": ["signature", "macho", "structure"],
  android: ["structure", "flutter", "androidPackage"],
  ios: ["structure"],
  js: ["javascript"],
  windows: ["peResources", "managed"],
  "mach-o": ["signature", "macho"],
  elf: ["structure"],
  wasm: ["wasm"],
  sqlite: ["sqlite"],
  archive: ["structure"],
};

const RUNTIMES: Record<string, string> = { "dalvik-art": "Android runtime (Java/Kotlin)", flutter: "Flutter", native: "native code", javascript: "JavaScript", jvm: "JVM", "react-native": "React Native" };
const COMPONENTS: Record<string, string> = { dex: "DEX code files", native_libraries: "Native libraries", manifests: "Manifests", resources: "Resource tables", signing: "Signing files", jvm_classes: "JVM classes", javascript: "JavaScript files", bundle_metadata: "Info.plists", executables: "Executables", frameworks: "Frameworks", privileged_helpers: "Privileged helpers", launchd_plists: "Launch agents", helpers: "Helper apps" };
const REASONS: Record<string, string> = {
  provider_missing: "This check needs a helper tool that REA doesn't install for you.",
  provider_unavailable: "This check needs a helper tool that wasn't found on this machine.",
  unsupported_platform: "This check doesn't run on this operating system.",
  runtime_unsupported: "This check needs a different Node.js version.",
};
const order = (tone: string): number => ({ warn: 0, good: 1, info: 2 } as Record<string, number>)[tone] ?? 3;

let queue: Promise<void> = Promise.resolve();
let running = 0;
const busy = () => running > 0;

export function recipeFor(kind: string): Step[] {
  return (RECIPES[kind] ?? []).flatMap((id) => steps[id] ?? []);
}

// Short type marks for the header when there's no app icon.
const MARKS: Record<string, string> = { electron: "APP", "mac-app": "APP", android: "APK", ios: "IPA", js: "JS", windows: "EXE", "mach-o": "BIN", elf: "ELF", wasm: "WASM", sqlite: "DB", archive: "ZIP" };
const when = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

// ---------- analysis page ----------
// deps: { h, api, startCall, cancelCall, renderResult, evidenceCtx, toolExists, availabilityOf, iconUrl, onChange, rerun, remove, reaSession }
//
// Each check ends as one saved step: { id, status: "done" | "failed" | "skipped" | "locked", record?, message?, availability? }.
// A live run and a reopened analysis render through the same code, so a saved page matches the original.
function analysisView(deps: AnalysisDeps, analysis: Analysis, detected: ReaData) {
  const { h } = deps;
  const info = KINDS[analysis.kind] ?? { label: "File", blurb: "" };
  const mark = () => h("div", { class: "kind-icon big", text: MARKS[analysis.kind] ?? "?" });
  const actions = h("div", { class: "analysis-actions" });
  const meta = h("span", { class: "muted small analysis-meta" });
  const header = h(
    "div",
    { class: "analysis-head" },
    detected.path.endsWith(".app") ? h("img", { class: "app-icon big", alt: "", src: deps.iconUrl(detected.path), onerror: (e: Event) => (e.target as HTMLElement).replaceWith(mark()) }) : mark(),
    h("div", { class: "grow" }, h("h1", { text: analysis.name }), h("div", { class: "muted" }, h("span", { class: "badge accent", text: info.label }), " ", h("span", { class: "path", text: detected.path })), meta),
    actions,
  );
  const glance = h("div", { class: "glance" });
  const highlights = h("div", { class: "worth" });
  const cards = recipeFor(analysis.kind).map((step) => stepCard(deps, step));
  glance.append(
    ...cards.map((card) => {
      const tile = h("button", { class: "glance-tile waiting", onclick: () => card.el.scrollIntoView({ behavior: "smooth", block: "start" }) }, h("div", { class: "glance-label", text: card.step.title }), h("div", { class: "glance-value", text: "Waiting" }));
      card.onState = (cls: string, text: string) => {
        tile.className = `glance-tile ${cls}`;
        if (tile.lastChild) tile.lastChild.textContent = text;
      };
      return tile;
    }),
  );
  analysis.page = h("div", { class: "analysis" }, header, h("p", { class: "lede", text: info.blurb }), h("div", { class: "card overview" }, h("div", { class: "card-title", text: "At a glance" }), glance, highlights), ...cards.map((c) => c.el));

  const findings: { tone: string; text: string; step: string }[] = [];
  // Drill-downs read evidence REA keeps in memory; after a restart those IDs no longer resolve.
  const stale = () => Boolean(analysis.reaSession) && analysis.reaSession !== deps.reaSession();
  const view = {
    cards,
    // Show a finished step on its card and fold it into the overview and the chat context.
    apply(card: StepCard, entry: StepEntry) {
      if (entry.status === "skipped") return card.skip(entry.message ?? "");
      if (entry.status === "locked") return card.locked(entry.availability ?? {});
      if (entry.status === "failed") return card.fail(entry.message ?? "", entry.record ?? null);
      if (!entry.record) return card.skip("No result was saved.");
      const parsed = parse(entry.record);
      let summary: Summary;
      try {
        summary = card.step.summarize(parsed, entry.record);
      } catch {
        summary = { headline: "Done", facts: [], findings: [] };
      }
      card.done(summary, entry.record, parsed, { stale: stale() });
      analysis.results.push({ check: card.step.title, headline: summary.headline, facts: summary.facts.filter(([, v]) => v != null && v !== ""), findings: summary.findings.map(([tone, text]) => `${tone}: ${text}`) });
      for (const f of summary.findings) findings.push({ tone: f[0], text: f[1], step: card.step.title });
      if (summary.findings.some(([tone]) => tone === "warn")) card.onState?.("done warn", summary.headline || "Done");
      view.highlights();
    },
    // Only the points worth a closer look; everything else lives in each check's card.
    highlights(final = false) {
      const warns = findings.filter((f) => f.tone === "warn");
      if (!warns.length) {
        highlights.replaceChildren(final ? h("p", { class: "muted small", text: "Nothing stood out. Each check's details are below." }) : "");
        return;
      }
      const LIMIT = 5;
      const list = h("ul", { class: "findings" }, ...warns.slice(0, LIMIT).map((f) => findingItem(h, [f.tone, f.text], f.step)));
      const more =
        warns.length > LIMIT
          ? h("button", {
              class: "link",
              text: `Show ${warns.length - LIMIT} more findings`,
              onclick: (e: MouseEvent) => (list.replaceChildren(...warns.map((f) => findingItem(h, [f.tone, f.text], f.step))), (e.target as HTMLElement).remove()),
            })
          : null;
      highlights.replaceChildren(...[h("div", { class: "section-label", text: `Worth a look (${warns.length})` }), list, more].filter((x) => x !== null));
    },
    // Header for a finished (or interrupted) analysis: when it ran, and what you can do with it.
    finish() {
      view.highlights(true);
      // "interrupted": saved mid-run, then the tab closed or reloaded (or another tab is still running it).
      const label = ({ done: "Analyzed", stopped: "Stopped", interrupted: "Didn't finish; last saved" } as Record<string, string>)[analysis.state] ?? "Analyzed";
      meta.textContent = `${label} ${when(analysis.finishedAt ?? analysis.at)}`;
      actions.replaceChildren(
        h("button", { class: "ghost", text: "Remove", title: "Delete this saved analysis", onclick: () => confirm(`Remove the saved analysis of ${analysis.name}?`) && deps.remove(analysis) }),
        h("button", { class: "primary", text: "Run again", onclick: () => deps.rerun(analysis.path) }),
      );
    },
    actions,
    meta,
  };
  return view;
}

export function runAnalysis(deps: AnalysisDeps, detected: ReaData, kind: string): Analysis {
  const { h } = deps;
  const analysis: Analysis = {
    id: `a${Date.now().toString(36)}`,
    path: detected.path,
    name: (fileName(detected.path) ?? detected.path).replace(/\.app$/, ""),
    kind,
    detected,
    at: Date.now(),
    finishedAt: null,
    state: "running",
    reaSession: deps.reaSession(),
    steps: [],
    results: [],
    page: null,
  };
  const view = analysisView(deps, analysis, detected);
  const { cards } = view;
  let stopped = false;
  analysis.waiting = busy();
  let currentCall: string | null = null;
  view.meta.textContent = `Started ${when(analysis.at)}`;
  view.actions.append(
    h("button", {
      class: "ghost danger",
      text: "Stop analysis",
      onclick: () => {
        stopped = true;
        if (currentCall) deps.cancelCall(currentCall);
      },
    }),
  );

  const ctx: StepContext = {
    h,
    kind,
    path: detected.path,
    detected,
    opened: false,
    toolExists: deps.toolExists,
    parse,
    progress: () => {},
    async call(name: string, args: ReaData) {
      if (stopped) throw new Error("Stopped");
      const { callId, done } = await deps.startCall(name, args, (p: ReaData) => ctx.progress(p.message ?? (p.total ? `${p.progress}/${p.total}` : "")), ctx.path);
      currentCall = callId;
      const record = await done;
      currentCall = null;
      return record;
    },
    // open_binary sets REA's active target for inspect_signature, inspect_macho and inspect_artifact.
    async ensureOpen() {
      if (ctx.opened) return null;
      const record = await ctx.call("open_binary", { path: ctx.path });
      if (record.state !== "done" || record.result?.isError) return record;
      ctx.opened = true;
      return null;
    },
  };

  // Decide how one check ends; the caller records and shows the outcome.
  async function check(card: StepCard): Promise<StepEntry> {
    const skipped = (message: string): StepEntry => ({ id: card.step.id, status: "skipped", message });
    if (stopped) return skipped("Stopped");
    const missing = card.step.tools.find((t) => !deps.toolExists(t));
    if (missing) return skipped(`This REA version has no ${missing} tool.`);
    // Other reasons describe whatever target happens to be open; this flow opens its own.
    const blocked = card.step.tools.map((t) => deps.availabilityOf(t)).find((a) => a?.available === false && (a.reason ?? "") in REASONS);
    if (blocked) return { id: card.step.id, status: "locked", availability: blocked };
    card.start();
    ctx.progress = (text: string) => card.progress(text);
    let record: CallRecord | null;
    try {
      record = keep(await card.step.run(ctx));
    } catch (err) {
      return stopped ? skipped("Stopped before this check started.") : { id: card.step.id, status: "failed", message: err instanceof Error ? err.message : String(err) };
    }
    if (stopped) return skipped("Stopped before this check finished.");
    const parsed = parse(record);
    if (!record || record.state !== "done" || record.result?.isError || !parsed) return { id: card.step.id, status: "failed", message: record ? failureMessage(record, parsed) : "REA returned no result", record };
    return { id: card.step.id, status: "done", record };
  }

  // REA has one active target, so analyses run one at a time.
  const previous = queue;
  let release = () => {};
  queue = new Promise<void>((resolve) => (release = resolve));
  (async () => {
    running++;
    deps.onChange(analysis);
    if (analysis.waiting) {
      cards[0]?.queued();
      await previous;
    }
    try {
      for (const card of cards) {
        const entry = await check(card);
        analysis.steps.push(entry);
        if (entry.status === "failed") analysis.failedChecks = (analysis.failedChecks ?? 0) + 1;
        view.apply(card, entry);
        // Save after every check, so closing the tab mid-run keeps what already finished.
        deps.onChange(analysis);
      }
    } finally {
      running--;
      release();
    }
    analysis.state = stopped ? "stopped" : "done";
    analysis.finishedAt = Date.now();
    view.finish();
    deps.onChange(analysis);
  })();

  return analysis;
}

// Rebuild a saved analysis without calling REA again.
export function restoreAnalysis(deps: AnalysisDeps, saved: ReaData): Analysis {
  const analysis: Analysis = { ...saved, state: saved.state === "running" ? "interrupted" : saved.state, results: [], page: null };
  const view = analysisView(deps, analysis, saved.detected ?? { path: saved.path });
  for (const card of view.cards) {
    const entry = (saved.steps as StepEntry[]).find((e) => e.id === card.step.id);
    if (entry) view.apply(card, entry);
    else card.skip(analysis.state === "interrupted" ? "Didn't run: the analysis hadn't reached this check when it was last saved." : "Didn't run.");
  }
  view.finish();
  return analysis;
}

// The parts of a call record the page needs; progress and routing details aren't worth saving.
function keep(record: CallRecord | null): CallRecord | null {
  if (!record) return record;
  const { name, arguments: args, state, result, error, startedAt, finishedAt, inventory } = record;
  return { name, arguments: args, state, result, error, startedAt, finishedAt, ...(inventory ? { inventory } : {}) };
}

type StepCard = ReturnType<typeof stepCard>;
function stepCard(deps: AnalysisDeps, step: Step) {
  const { h } = deps;
  const icon = h("span", { class: "step-state", text: "○" });
  const headline = h("span", { class: "step-headline muted", text: "Waiting" });
  const body = h("div", { class: "step-body" });
  const el = h("section", { class: "card step-card waiting" }, h("div", { class: "step-top" }, icon, h("div", { class: "grow" }, h("div", { class: "card-title", text: step.title }), h("div", { class: "muted small", text: step.why })), headline), body);
  let timer: ReturnType<typeof setInterval> | undefined;
  const set = (cls: string, symbol: ReaData, text: string) => {
    el.className = `card step-card ${cls}`;
    icon.textContent = symbol;
    headline.textContent = text;
    clearInterval(timer);
    card.onState?.(cls, text);
  };
  const details = (record: CallRecord) => {
    const container = h("div");
    const det = h("details", { class: "step-details" }, h("summary", { text: "Show full REA result" }), container);
    det.addEventListener("toggle", () => det.open && !container.childNodes.length && deps.renderResult(container, record), { once: false });
    return det;
  };
  const card = {
    el,
    step,
    progressEl: null as HTMLElement | null,
    onState: undefined as ((cls: string, text: string) => void) | undefined,
    start() {
      set("running", "◌", "Running…");
      const started = Date.now();
      const message = h("span", { class: "muted small", text: step.slow ? "Large apps can take a few minutes. You can open other pages meanwhile; this keeps running." : "" });
      body.replaceChildren(h("div", { class: "progress" }, h("div")), message);
      this.progressEl = message;
      timer = setInterval(() => {
        headline.textContent = `Running… ${elapsed(started)}`;
        card.onState?.("running", headline.textContent);
      }, 1000);
    },
    progress(text: string) {
      if (this.progressEl && text) this.progressEl.textContent = text;
    },
    done(summary: Summary, record: CallRecord, parsed: ReaData, { stale = false } = {}) {
      set("done", "✓", summary.headline || "Done");
      const facts = summary.facts.filter(([, v]) => v !== null && v !== undefined && v !== "");
      const drills = h("div", { class: "drills" });
      let explore: HTMLElement | null = null;
      if (summary.explore && stale) {
        explore = h("p", { class: "muted small", text: "Drill-downs read data REA keeps only while it runs, and REA has restarted since this analysis. The results above and the full REA result are saved. Run the analysis again to explore further." });
      } else if (summary.explore) {
        explore = exploreFor(deps.evidenceCtx(drills), parsed);
        explore?.querySelector(".section-label")?.replaceChildren("Look closer");
      }
      // Short values read best as tiles; identifiers, dates and hashes as a key/value list.
      const tiles = facts.filter(([, v]) => String(n(v)).length <= 14);
      const rows = facts.filter(([, v]) => String(n(v)).length > 14);
      body.replaceChildren(
        ...[
          summary.findings.length ? h("ul", { class: "findings" }, ...[...summary.findings].sort((a, b) => order(a[0]) - order(b[0])).map((f) => findingItem(h, f))) : null,
          tiles.length ? h("div", { class: "stats" }, ...tiles.map(([k, v]) => h("div", { class: "stat", title: String(v) }, h("div", { class: "stat-value", text: n(v) }), h("div", { class: "stat-label", text: k })))) : null,
          rows.length ? h("dl", { class: "kv" }, ...rows.flatMap(([k, v]) => [h("dt", { text: k }), h("dd", { text: String(v) })])) : null,
          explore,
          drills,
          details(record),
        ].filter((x) => x !== null),
      );
    },
    fail(message: string, record: CallRecord | null) {
      set("failed", "✕", "Couldn't complete");
      body.replaceChildren(...[h("p", { class: "error-text", text: message }), record ? details(record) : null].filter((x) => x !== null));
    },
    queued() {
      set("waiting", "○", "Queued");
      body.replaceChildren(h("p", { class: "muted small", text: "Waiting for the analysis that's already running to finish." }));
    },
    skip(message: string) {
      set("skipped", "–", "Skipped");
      body.replaceChildren(h("p", { class: "muted small", text: message }));
    },
    locked(availability: Availability) {
      set("locked", "○", "Needs setup");
      body.replaceChildren(
        ...[
          h("p", { class: "small", text: REASONS[availability.reason ?? ""] ?? "This check isn't available on this machine." }),
          availability.remediation ? h("p", { class: "muted small", text: availability.remediation }) : null,
        ].filter((x) => x !== null),
      );
    },
  };
  return card;
}

function findingItem(h: H, [tone, text]: Finding, source?: string) {
  return h("li", { class: `finding ${tone}` }, h("span", { class: "finding-icon", text: tone === "warn" ? "⚠" : tone === "good" ? "✓" : "•" }), h("span", { text }), source ? h("span", { class: "finding-source", text: source }) : null);
}

function parse(record: CallRecord | null): ReaData {
  const text = record?.result?.content?.find((c: ReaData) => c.type === "text")?.text;
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function failureMessage(record: CallRecord, parsed: ReaData): string {
  if (record.state === "error") {
    const message = record.error?.message ?? "REA call failed";
    if (/server exited|not running|restarted/i.test(message)) return "REA restarted while this check was running, so it didn't finish. Run the analysis again.";
    return message;
  }
  const error = parsed?.error;
  if (error) {
    const fix = error.remediation?.action && error.remediation.action !== error.message ? ` ${error.remediation.action}` : "";
    return `${error.message}${fix}`;
  }
  const text = record.result?.content?.find((c: ReaData) => c.type === "text")?.text ?? "";
  return text.slice(0, 400) || "REA returned no result";
}
