// Readable rendering for REA Evidence envelopes and their analysis views.
// ctx: { h, jsonTree, callAndWait(name, args) -> record, viewTool }

export function isEvidence(value) {
  return Boolean(value && typeof value === "object" && typeof value.evidence_id === "string" && "normalized_result" in value);
}

// Which inspect_analysis_view variants apply to each parent operation.
const OPERATION_VIEWS = {
  analyze_javascript_application: [
    {
      facts: ["ipc-channel", "ipc-handler", "context-bridge-api", "browser-window", "electron-main", "electron-preload", "endpoint", "storage", "native-addon", "worker"],
    },
    { kind: "page", dim: "collection", only: ["modules"] },
  ],
  inspect_binary_layout: [{ kind: "page", dim: "collection", only: ["sections", "symbols"] }, { kind: "facet", dim: "facet" }],
  inspect_macho: [{ kind: "macho", dim: "facet" }],
  analyze_function: [{ kind: "native", dim: "facet" }],
  inspect_wasm_artifact: [{ kind: "wasm", dim: "facet" }],
  inspect_evm_interface: [{ kind: "evm", dim: "facet" }],
  inspect_managed_artifact: [{ kind: "managed", dim: "collection" }],
  inspect_managed_members: [{ kind: "managed-members", dim: "collection" }],
  inspect_android_package: [{ kind: "android", dim: "facet" }],
  inspect_dart_aot: [{ kind: "dart-aot", dim: "collection" }],
};

const PAGE_LIMIT = 50;

const FACT_LABELS = {
  "ipc-channel": "IPC channels",
  "ipc-handler": "IPC handlers",
  "context-bridge-api": "APIs exposed to web pages",
  "browser-window": "Windows",
  "electron-main": "Main process entry",
  "electron-preload": "Preload scripts",
  endpoint: "Network endpoints",
  storage: "Storage",
  "native-addon": "Native addons",
  worker: "Workers",
};
const VIEW_LABELS = { modules: "All modules", load_commands: "Load commands", build_metadata: "Build info", entrypoints: "Entry points" };

// Flatten the view schema's nested oneOf into { kind -> properties }.
export function viewVariants(viewTool) {
  const variants = {};
  const visit = (schema) => {
    if (!schema || typeof schema !== "object") return;
    for (const option of schema.oneOf ?? schema.anyOf ?? []) visit(option);
    const kind = schema.properties?.kind?.const;
    if (kind && !variants[kind]) variants[kind] = schema.properties;
  };
  visit(viewTool?.inputSchema?.properties?.view);
  return variants;
}

function enumOf(schema) {
  if (!schema) return [];
  if (schema.enum) return schema.enum;
  if (schema.const !== undefined) return [schema.const];
  return [];
}

function buildView(variant, kind, dim, value, offset = 0) {
  const view = { kind };
  if (dim) view[dim] = value;
  if (variant.offset) view.offset = offset;
  if (variant.limit) view.limit = PAGE_LIMIT;
  if (variant.projection) view.projection = enumOf(variant.projection)[0];
  return view;
}

const short = (text, n = 12) => (typeof text === "string" && text.length > n + 6 ? `${text.slice(0, n)}…` : text);
const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);
const label = (key) => key.replace(/[_-]/g, " ");
const isPrimitive = (v) => v === null || ["string", "number", "boolean"].includes(typeof v);

export function renderEvidence(ev, ctx) {
  const { h, jsonTree } = ctx;
  const nr = ev.normalized_result ?? {};
  const parentId = nr.parent_evidence_id ?? ev.evidence_id;
  const parentOp = nr.parent_operation ?? ev.operation;
  const root = h("div", { class: "evidence" });

  // ---- header ----
  const subject = ev.subject;
  const coverage = nr.coverage ?? ev.relationship_coverage ?? null;
  root.append(
    h(
      "div",
      { class: "ev-header" },
      h(
        "div",
        { class: "ev-title" },
        h("strong", { text: subject?.name ?? parentOp }),
        subject?.format ? h("span", { class: "badge", text: subject.format }) : null,
        subject?.architecture ? h("span", { class: "badge", text: subject.architecture }) : null,
        h("span", { class: "badge accent", text: nr.kind && nr.kind !== parentOp ? `${parentOp} · ${nr.kind}` : parentOp }),
        ev.confidence ? h("span", { class: "badge", title: "Confidence", text: ev.confidence }) : null,
        ev.authority ? h("span", { class: "badge", title: "Authority", text: ev.authority }) : null,
      ),
      subject?.local_path ? h("div", { class: "ev-path", text: subject.local_path }) : null,
      h(
        "div",
        { class: "ev-ids" },
        subject?.digest?.sha256 ? h("span", { title: subject.digest.sha256, text: `sha256 ${short(subject.digest.sha256, 16)}` }) : null,
        h("span", { title: ev.evidence_id, text: `evidence ${short(ev.evidence_id, 14)}` }),
        coverage ? coverageBadge(h, coverage) : null,
      ),
    ),
  );

  // ---- body ----
  let rows = Array.isArray(nr.items) ? nr.items : Array.isArray(nr.item) ? nr.item : Array.isArray(nr.rows) ? nr.rows : null;
  if (rows && nr.kind === "javascript-facts") {
    // A single-kind filter makes the kind column redundant.
    const singleKind = nr.view?.where?.kinds?.length === 1;
    rows = rows.map((row) => {
      const flat = flattenFact(row);
      if (singleKind) delete flat.kind;
      return flat;
    });
  }
  if (/^project_(android|apple)_application_graph$/.test(ev.operation) && nr.components) {
    root.append(appGraph(h, jsonTree, nr));
  } else if (nr.kind === "summary" && nr.summary) {
    root.append(h("div", { class: "section-label", text: "Summary" }), facts(h, jsonTree, nr.summary, 0));
  } else if (rows) {
    root.append(rowsTable(ctx, rows, { parentId, parentOp }));
  } else if (nr.item && typeof nr.item === "object") {
    root.append(h("div", { class: "section-label", text: "Item" }), facts(h, jsonTree, nr.item, 0));
  } else if (ev.normalized_result && typeof ev.normalized_result === "object") {
    const { limitations, unknowns, coverage: _c, ...rest } = ev.normalized_result;
    root.append(h("div", { class: "section-label", text: "Result" }), facts(h, jsonTree, rest, 0));
  }

  // ---- explore ----
  const explore = ctx.inDrill ? null : exploreButtons(ctx, parentId, parentOp);
  if (explore) root.append(explore);

  // ---- limitations / unknowns ----
  const limitations = [...new Set([...(nr.limitations ?? []), ...(ev.limitations ?? [])])];
  const unknowns = nr.unknowns ?? [];
  if (limitations.length) root.append(listSection(h, `Limitations (${limitations.length})`, limitations));
  if (unknowns.length) root.append(listSection(h, `Unknowns (${unknowns.length})`, unknowns.map((u) => (isPrimitive(u) ? String(u) : JSON.stringify(u)))));

  root.append(
    h("details", { class: "ev-raw" }, h("summary", { text: "Full Evidence record" }), jsonTree(ev, 1)),
  );
  return root;
}

function coverageBadge(h, coverage) {
  const status = coverage.status ?? "unknown";
  const tone = /complete|exhausted/.test(status) ? "ok" : status === "page" ? "" : "warn";
  const counts = coverage.total != null ? ` · ${coverage.examined ?? "?"}/${coverage.total}` : "";
  return h("span", { class: `badge ${tone}`, title: JSON.stringify(coverage), text: `coverage ${status}${counts}` });
}

export const renderFacts = (h, jsonTree, value) => facts(h, jsonTree, value, 0);

// Android/Apple application inventory: counts, runtimes, then one table per component group.
function appGraph(h, jsonTree, nr) {
  const groups = Object.entries(nr.components).filter(([, list]) => Array.isArray(list));
  const section = (title, body) => h("div", {}, h("div", { class: "section-label", text: title }), body);
  const fileRows = (list) => list.map((c) => ({ path: c.path, format: c.format, sha256: short(c.sha256, 16), ...Object.fromEntries(Object.entries(c).filter(([k]) => !["path", "format", "sha256", "artifact_id"].includes(k))) }));
  return h(
    "div",
    { class: "facts" },
    h(
      "div",
      { class: "chips" },
      ...(nr.platforms ?? [nr.root_format]).map((p) => h("span", { class: "badge accent", text: p })),
      ...(nr.runtime_families ?? []).map((r) => h("span", { class: "badge", title: "Runtime family", text: r })),
    ),
    h(
      "div",
      { class: "stats" },
      ...groups.map(([name, list]) => h("div", { class: `stat${list.length ? "" : " empty-stat"}` }, h("div", { class: "stat-value", text: list.length.toLocaleString() }), h("div", { class: "stat-label", text: label(name) }))),
    ),
    nr.bundles?.length ? section(`Bundles (${nr.bundles.length})`, simpleTable(h, nr.bundles, { jsonTree })) : null,
    ...groups.filter(([, list]) => list.length).map(([name, list]) => section(`${label(name)} (${list.length})`, simpleTable(h, fileRows(list), { jsonTree }))),
    nr.bridge_candidates?.length ? section(`Managed ↔ native bridges (${nr.bridge_candidates.length})`, simpleTable(h, nr.bridge_candidates, { jsonTree })) : null,
    nr.unavailable_components?.length ? section("Not determinable from inventory", facts(h, jsonTree, nr.unavailable_components, 1)) : null,
  );
}

// Render an object as stat tiles for scalar fields and subsections for nested ones.
function facts(h, jsonTree, value, depth) {
  if (isPrimitive(value)) return h("div", { class: "leaf-value", text: String(value) });
  if (Array.isArray(value)) {
    if (!value.length) return h("div", { class: "muted", text: "none" });
    if (value.every(isPrimitive)) return h("div", { class: "chips" }, ...value.slice(0, 200).map((v) => h("span", { class: "chip", text: String(v) })));
    if (value.every((v) => v && typeof v === "object" && !Array.isArray(v))) return simpleTable(h, value, { jsonTree });
    return jsonTree(value, 1);
  }
  const entries = Object.entries(value);
  // Short scalars become stat tiles; long strings (paths, digests) become key/value rows.
  const isLong = (v) => typeof v === "string" && v.length > 28;
  const scalars = entries.filter(([, v]) => isPrimitive(v) && !isLong(v));
  const longs = entries.filter(([, v]) => isLong(v));
  const nested = entries.filter(([, v]) => !isPrimitive(v));
  const box = h("div", { class: depth ? "facts nested" : "facts" });
  if (scalars.length) {
    box.append(
      h(
        "div",
        { class: "stats" },
        ...scalars.map(([k, v]) =>
          h("div", { class: "stat", title: String(v) }, h("div", { class: "stat-value", text: v === null ? "—" : typeof v === "number" ? v.toLocaleString() : String(v) }), h("div", { class: "stat-label", text: label(k) })),
        ),
      ),
    );
  }
  if (longs.length) {
    box.append(
      h("dl", { class: "kv" }, ...longs.flatMap(([k, v]) => [h("dt", { text: label(k) }), h("dd", { text: v })])),
    );
  }
  for (const [k, v] of nested) {
    if (depth >= 2) {
      box.append(h("div", { class: "fact-title", text: label(k) }), jsonTree(v, 0));
    } else {
      box.append(h("div", { class: "fact-title", text: label(k) }), facts(h, jsonTree, v, depth + 1));
    }
  }
  return box;
}

// One JavaScript fact row: its properties plus where and how confidently it was observed.
function flattenFact(row) {
  const location = row.evidence?.location?.value;
  const where = location?.source ? `${location.source}${location.start ? `:${location.start.line}:${location.start.column}` : ""}` : "";
  return {
    kind: row.kind,
    ...row.properties,
    location: where,
    confidence: row.evidence?.confidence ?? null,
    state: row.evidence?.state ?? null,
  };
}

function cellText(v) {
  if (v === null || v === undefined) return "—";
  if (isPrimitive(v)) return String(v);
  if (Array.isArray(v) && v.every(isPrimitive)) return v.length ? v.join(", ") : "—";
  const json = JSON.stringify(v);
  return json.length > 160 ? `${json.slice(0, 160)}…` : json;
}

function simpleTable(h, rows, { onRow, jsonTree } = {}) {
  const columns = [];
  for (const row of rows.slice(0, 100)) for (const key of Object.keys(row)) if (!columns.includes(key)) columns.push(key);
  // Drop columns that carry no value in any row.
  for (let i = columns.length - 1; i >= 0; i--) {
    if (columns.length > 1 && rows.every((r) => r[columns[i]] === null || r[columns[i]] === undefined)) columns.splice(i, 1);
  }
  let sortKey = null;
  let sortDir = 1;
  const tbody = h("tbody");
  const draw = () => {
    const sorted = sortKey ? [...rows].sort((a, b) => (cellText(a[sortKey]) > cellText(b[sortKey]) ? sortDir : -sortDir)) : rows;
    tbody.replaceChildren(
      ...sorted.map((row) =>
        h(
          "tr",
          {
            class: "clickable",
            title: onRow ? "Open" : "Show details",
            onclick: (e) => {
              if (onRow) return onRow(row);
              // Toggle an inline detail row with the complete record.
              const tr = e.currentTarget;
              if (tr.nextSibling?.classList?.contains("detail-row")) return tr.nextSibling.remove();
              tr.after(h("tr", { class: "detail-row" }, h("td", { colSpan: columns.length }, jsonTree ? jsonTree(row, 2) : JSON.stringify(row, null, 2))));
            },
          },
          ...columns.map((c) => {
            const text = cellText(row[c]);
            const display = /(^|_)(id|sha256|digest)$/.test(c) ? short(text, 18) : text;
            return h("td", { title: text.length > 40 ? text : "", text: display });
          }),
        ),
      ),
    );
  };
  const thead = h(
    "thead",
    {},
    h(
      "tr",
      {},
      ...columns.map((c) =>
        h("th", {
          text: label(c),
          onclick: () => {
            sortDir = sortKey === c ? -sortDir : 1;
            sortKey = c;
            draw();
          },
        }),
      ),
    ),
  );
  draw();
  return h("div", { class: "table-wrap" }, h("table", { class: "data" }, thead, tbody));
}

function rowsTable(ctx, rows, { parentId, parentOp }) {
  const { h } = ctx;
  // JavaScript modules can be opened individually by node_id.
  const onRow =
    parentOp === "analyze_javascript_application" && rows[0]?.node_id
      ? (row) =>
          ctx.drill(`module ${row.path ?? row.node_id}`, {
            source: { kind: "retained-evidence", evidence_id: parentId },
            view: { kind: "item", collection: "modules", selector: { node_id: row.node_id } },
          })
      : null;
  const wrap = h("div");
  wrap.append(h("div", { class: "section-label", text: `${rows.length} ${rows.length === 1 ? "row" : "rows"} · click a row to ${onRow ? "open it" : "see details"}` }));
  wrap.append(rows.length ? simpleTable(h, rows, { onRow, jsonTree: ctx.jsonTree }) : h("div", { class: "muted", text: "No rows" }));
  return wrap;
}

function exploreButtons(ctx, parentId, parentOp) {
  const { h } = ctx;
  const plans = OPERATION_VIEWS[parentOp];
  if (!plans || !ctx.viewTool) return null;
  const variants = viewVariants(ctx.viewTool);
  const buttons = [];
  const factButtons = [];
  for (const plan of plans) {
    if (plan.facts) {
      if (!variants["javascript-facts"]) continue;
      for (const factKind of plan.facts) {
        factButtons.push(
          h("button", {
            class: "small primary-soft",
            text: FACT_LABELS[factKind] ?? label(factKind),
            onclick: () =>
              ctx.drill(FACT_LABELS[factKind] ?? label(factKind), {
                source: { kind: "retained-evidence", evidence_id: parentId },
                view: { kind: "javascript-facts", where: { kinds: [factKind] }, property_keys: [], include_available_property_keys: true, offset: 0, limit: PAGE_LIMIT },
              }),
          }),
        );
      }
      continue;
    }
    const variant = variants[plan.kind];
    if (!variant) continue;
    const values = enumOf(variant[plan.dim]).filter((v) => !plan.only || plan.only.includes(v));
    for (const value of values) {
      buttons.push(
        h("button", {
          class: "ghost small",
          text: VIEW_LABELS[value] ?? capitalize(label(String(value))),
          onclick: () =>
            ctx.drill(VIEW_LABELS[value] ?? capitalize(label(String(value))), {
              source: { kind: "retained-evidence", evidence_id: parentId },
              view: buildView(variant, plan.kind, plan.dim, value),
            }),
        }),
      );
    }
  }
  if (!buttons.length && !factButtons.length) return null;
  return h(
    "div",
    { class: "explore" },
    h("div", { class: "section-label", text: "Explore this evidence" }),
    factButtons.length ? h("div", { class: "chips" }, ...factButtons) : null,
    buttons.length ? h("div", { class: "chips" }, ...buttons) : null,
  );
}

// Explore buttons for one Evidence record, for callers that render their own summary.
export function exploreFor(ctx, ev) {
  const nr = ev.normalized_result ?? {};
  return exploreButtons(ctx, nr.parent_evidence_id ?? ev.evidence_id, nr.parent_operation ?? ev.operation);
}

function listSection(h, title, items) {
  return h(
    "details",
    { class: "ev-list" },
    h("summary", { text: title }),
    h("ul", {}, ...items.slice(0, 500).map((item) => h("li", { text: item }))),
  );
}

// A drill-down panel: runs inspect_analysis_view and supports paging via coverage.next_offset.
export function drillPanel(ctx, title, args) {
  const { h } = ctx;
  const panel = h("div", { class: "drill card" });
  const load = async (initialArgs) => {
    let viewArgs = initialArgs;
    panel.replaceChildren(h("div", { class: "drill-head" }, h("strong", { text: title }), h("span", { class: "muted", text: " loading…" })));
    let record = await ctx.callAndWait("inspect_analysis_view", viewArgs);
    // javascript-facts needs exact property names: discover them, then read their values.
    if (viewArgs.view.kind === "javascript-facts" && viewArgs.view.include_available_property_keys && !record.result?.isError) {
      const discovered = JSON.parse(record.result.content.find((c) => c.type === "text").text);
      const keys = [...new Set((discovered.normalized_result?.rows ?? []).flatMap((r) => r.available_property_keys ?? []))];
      if (keys.length) {
        viewArgs = { ...viewArgs, view: { ...viewArgs.view, property_keys: keys, include_available_property_keys: false } };
        record = await ctx.callAndWait("inspect_analysis_view", viewArgs);
      }
    }
    const text = record.result?.content?.find((c) => c.type === "text")?.text;
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    const head = h("div", { class: "drill-head" }, h("strong", { text: title }), h("span", { class: "spacer" }));
    const view = viewArgs.view;
    const coverage = parsed?.normalized_result?.coverage;
    if (coverage && typeof view.offset === "number") {
      const limit = view.limit ?? PAGE_LIMIT;
      const from = view.offset + 1;
      const to = view.offset + (coverage.examined ?? 0);
      head.append(
        h("span", { class: "muted", text: `${from}–${to}${coverage.total != null ? ` of ${coverage.total}` : ""}` }),
        h("button", { class: "ghost small", text: "← Prev", disabled: view.offset === 0, onclick: () => load({ ...viewArgs, view: { ...view, offset: Math.max(0, view.offset - limit) } }) }),
        h("button", { class: "ghost small", text: "Next →", disabled: coverage.next_offset == null, onclick: () => load({ ...viewArgs, view: { ...view, offset: coverage.next_offset } }) }),
      );
    }
    head.append(h("button", { class: "ghost small", text: "Close", title: "Close", onclick: () => panel.remove() }));
    if (record.state === "error" || record.result?.isError || !parsed) {
      panel.replaceChildren(head, ctx.renderFailure(record, parsed));
    } else if (isEvidence(parsed)) {
      panel.replaceChildren(head, renderEvidence(parsed, { ...ctx, inDrill: true }));
    } else {
      panel.replaceChildren(head, ctx.jsonTree(parsed, 2));
    }
  };
  load(args);
  return panel;
}
