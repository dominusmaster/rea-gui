// OpenRouter chat: any tool-capable model on openrouter.ai drives REA through the
// OpenAI-style Chat Completions API.
//
// OpenRouter has no server-side tool search, and REA's ~200 tool schemas are far too
// large to send every turn. So the model gets the agent's starter tools plus a local
// search_tools function; tools it finds are added to the request from then on.
import { ChatSession } from "./agent.mjs";

const BASE_URL = () => (process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/+$/, "");
const HEADERS = { "HTTP-Referer": "https://github.com/dominusmaster/rea-studio", "X-Title": "REA Studio" };
const MAX_OUTPUT = 32_000;
const SEARCH_LIMIT = 8;

const SEARCH_TOOL = {
  type: "function",
  function: {
    name: "search_tools",
    description:
      "Find REA tools by name or description. Matching tools become callable on your next step. Takes a case-insensitive regex such as \"electron|fuse\" or plain keywords such as \"android manifest\".",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "Regex or keywords to match against tool names and descriptions" } },
      required: ["query"],
    },
  },
};

// ---------- model list ----------
let modelCache = null; // { at, models }
const MODEL_TTL = 10 * 60 * 1000;

const perMillion = (price) => {
  const n = Number(price);
  if (!Number.isFinite(n) || n < 0) return null;
  return n * 1e6;
};
const money = (n) => (n === 0 ? "free" : n < 0.1 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`);

// Tool-capable models only: the REA assistant can't work without tool calls.
export async function listOpenRouterModels(apiKey, { refresh = false } = {}) {
  if (!refresh && modelCache && Date.now() - modelCache.at < MODEL_TTL) return modelCache.models;
  const res = await fetch(`${BASE_URL()}/models?supported_parameters=tools`, { headers: { ...HEADERS, ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) } });
  if (!res.ok) throw new Error(await errorText(res));
  const { data } = await res.json();
  const models = (data ?? [])
    // ":batch" variants are for batch jobs, not streamed chat.
    .filter((m) => m.supported_parameters?.includes("tools") && !m.id.endsWith(":batch"))
    .map((m) => {
      const input = perMillion(m.pricing?.prompt);
      const output = perMillion(m.pricing?.completion);
      const price = input === null || output === null ? null : input === 0 && output === 0 ? "free" : `${money(input)} in · ${money(output)} out per 1M tokens`;
      return {
        id: m.id,
        label: m.name ?? m.id,
        note: [price, m.context_length ? `${Math.round(m.context_length / 1000)}K context` : null].filter(Boolean).join(" · "),
        reasoning: Boolean(m.supported_parameters?.includes("reasoning")),
        maxOutput: m.top_provider?.max_completion_tokens ?? null,
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
  modelCache = { at: Date.now(), models };
  return models;
}

async function errorText(res) {
  const body = await res.text().catch(() => "");
  let message = body.slice(0, 500);
  try {
    const parsed = JSON.parse(body);
    message = parsed.error?.message ?? message;
    const raw = parsed.error?.metadata?.raw;
    if (raw && typeof raw === "string" && !message.includes(raw)) message += ` (${raw.slice(0, 300)})`;
  } catch {}
  if (res.status === 401) return "OpenRouter rejected the API key. Check the key and start a new chat.";
  if (res.status === 402) return "Your OpenRouter account is out of credits. Add credits at openrouter.ai/settings/credits, or pick a free model.";
  if (res.status === 429) return "Rate limited by OpenRouter. Wait a moment and try again.";
  if (res.status === 404 && /tool/i.test(message)) return `No provider for this model supports tool calls on OpenRouter. Pick another model. (${message})`;
  return `OpenRouter error ${res.status}: ${message || res.statusText}`;
}

// ---------- session ----------
export class OpenRouterSession extends ChatSession {
  /** @param {object} opts  opts.modelInfo is the entry from listOpenRouterModels, when known. */
  constructor(opts) {
    super(opts);
    this.provider = "openrouter";
    this.apiKey = opts.apiKey || process.env.OPENROUTER_API_KEY;
    this.model = opts.model || "openrouter/auto";
    this.modelInfo = opts.modelInfo ?? null;
    // Tools the model can call right now: the agent's starters, plus whatever search_tools finds.
    this.loaded = new Set(this.agentDef.starterTools);
    this.callSeq = 0;
  }

  addUserMessage(text) {
    this.messages.push({ role: "user", content: text });
  }

  #tools() {
    const defs = this.getMcpTools()
      .filter((t) => this.loaded.has(t.name))
      .map((t) => ({ type: "function", function: { name: t.name, description: t.description ?? "", parameters: t.inputSchema ?? { type: "object", properties: {} } } }));
    return [SEARCH_TOOL, ...defs];
  }

  #body(effort) {
    const maxOutput = Math.min(MAX_OUTPUT, this.modelInfo?.maxOutput ?? MAX_OUTPUT);
    return {
      model: this.model,
      messages: [{ role: "system", content: this.system }, ...this.messages],
      stream: true,
      max_tokens: maxOutput,
      ...(this.agentDef.usesRea ? { tools: this.#tools() } : {}),
      // Only ask for reasoning where the model supports it; others reject or ignore the field.
      ...(this.modelInfo?.reasoning ? { reasoning: { effort } } : {}),
    };
  }

  async turn(effort, signal) {
    let finish = null;
    while (!signal.aborted) {
      if (this.agentDef.usesRea) this.requireRea();
      const reply = await this.#stream(this.#body(effort), signal);
      finish = reply.finish;

      const message = { role: "assistant", content: reply.text || null };
      if (reply.calls.length) message.tool_calls = reply.calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.args || "{}" } }));
      // Send reasoning back unchanged so reasoning models can continue across tool calls.
      if (reply.details.length) message.reasoning_details = reply.details;
      else if (reply.reasoning) message.reasoning = reply.reasoning;
      this.messages.push(message);

      if (finish === "length") {
        this.emit({ type: "error", message: "The reply hit the output limit and was cut short." });
        for (const c of reply.calls) this.messages.push({ role: "tool", tool_call_id: c.id, content: "Not run: the tool call was cut off by the output limit." });
        break;
      }
      if (finish === "content_filter") {
        this.emit({ type: "error", message: "The model's provider filtered this reply." });
        break;
      }
      if (finish === "error") {
        this.emit({ type: "error", message: "The model's provider reported an error mid-reply. Try again, or pick another model." });
        break;
      }
      // Some providers report "stop" even with tool calls; the calls are what matter.
      if (!reply.calls.length) break;

      // Every tool call needs a matching tool message, even when stopped or declined.
      for (const call of reply.calls) {
        let input;
        try {
          input = call.args ? JSON.parse(call.args) : {};
        } catch {
          this.emit({ type: "tool_start", id: call.id, name: call.name, input: call.args });
          this.emit({ type: "tool_end", id: call.id, isError: true, result: "Invalid arguments" });
          this.messages.push({ role: "tool", tool_call_id: call.id, content: "Error: the arguments weren't valid JSON. Call the tool again with a JSON object." });
          continue;
        }
        const content = call.name === "search_tools" ? this.#searchTools(call.id, input) : await this.#callRea(call, input, signal);
        this.messages.push({ role: "tool", tool_call_id: call.id, content });
      }
    }
    return finish;
  }

  async #callRea(call, input, signal) {
    const { text, isError } = await this.runTool(call.id, call.name, input, signal);
    // A tool the model called by name without searching is loaded from now on.
    if (this.getMcpTools().some((t) => t.name === call.name)) this.loaded.add(call.name);
    return isError ? `Error: ${text}` : text;
  }

  // Local tool search: a regex over names and descriptions, falling back to "all keywords match".
  #searchTools(id, input) {
    const query = String(input?.query ?? "").trim();
    this.emit({ type: "tool_search", id });
    this.emit({ type: "tool_search_query", id, input: { query } });
    const found = findTools(this.getMcpTools(), query);
    for (const t of found) this.loaded.add(t.name);
    this.emit({ type: "tool_search_result", id, tools: found.map((t) => t.name) });
    if (!found.length) return `No tools matched "${query}". Try broader keywords or a shorter regex.`;
    return JSON.stringify({
      loaded: found.map((t) => ({ name: t.name, description: (t.description ?? "").split("\n")[0].slice(0, 300) })),
      note: "These tools are now callable.",
    });
  }

  // Stream one completion, forwarding text and reasoning to the browser as it arrives.
  async #stream(body, signal) {
    if (!this.apiKey) throw new Error("An OpenRouter API key is required. Add it in Chat settings, or set OPENROUTER_API_KEY.");
    const res = await fetch(`${BASE_URL()}/chat/completions`, {
      method: "POST",
      headers: { ...HEADERS, authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) throw new Error(await errorText(res));

    const reply = { text: "", reasoning: "", details: [], calls: [], finish: null };
    const slots = new Map(); // tool_call index → { id, name, args }
    let open = null; // "text" | "thinking": which block the browser is currently showing
    const show = (kind, text) => {
      if (!text) return;
      if (open !== kind) this.emit({ type: kind === "text" ? "text_start" : "thinking_start" });
      open = kind;
      this.emit({ type: kind, text });
    };

    const decoder = new TextDecoder();
    let buffer = "";
    let done = false;
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline;
      while (!done && (newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        // Lines starting with ":" are keep-alive comments (": OPENROUTER PROCESSING").
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") {
          done = true;
          break;
        }
        let event;
        try {
          event = JSON.parse(data);
        } catch {
          continue;
        }
        if (event.error) throw new Error(`OpenRouter error: ${event.error.message ?? JSON.stringify(event.error)}`);
        const choice = event.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta ?? {};
        if (delta.reasoning) {
          reply.reasoning += delta.reasoning;
          show("thinking", delta.reasoning);
        }
        for (const d of delta.reasoning_details ?? []) {
          mergeDetail(reply.details, d);
          // Most models also stream the same reasoning as plain text; only models that never do show the details.
          if (!reply.reasoning) show("thinking", d.text ?? d.summary ?? "");
        }
        if (delta.content) {
          reply.text += delta.content;
          show("text", delta.content);
        }
        for (const tc of delta.tool_calls ?? []) {
          const index = tc.index ?? slots.size;
          const slot = slots.get(index) ?? { id: "", name: "", args: "" };
          slots.set(index, slot);
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.name ||= tc.function.name;
          if (tc.function?.arguments) slot.args += tc.function.arguments;
        }
        if (choice.finish_reason) reply.finish = choice.finish_reason;
      }
      if (done) break;
    }
    reply.calls = [...slots.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, slot]) => ({ ...slot, id: slot.id || `call_${++this.callSeq}` }))
      .filter((c) => c.name);
    return reply;
  }
}

// Models send regexes and plain keywords alike. A query written as a regex ranks name matches
// above description matches; otherwise keywords are scored, a name hit counting more than a
// description hit, so "android manifest" still finds inspect_android_package.
export function findTools(tools, query) {
  let found = [];
  try {
    // Plain words are keywords; only queries using regex syntax are treated as a regex.
    if (!/[|^$*+?()[\]{}\\]/.test(query)) throw new Error("keywords");
    const re = new RegExp(query, "i");
    const byName = tools.filter((t) => re.test(t.name));
    found = [...byName, ...tools.filter((t) => !byName.includes(t) && re.test(t.description ?? ""))];
  } catch {}
  if (!found.length) {
    const words = query.toLowerCase().split(/[^a-z0-9.]+/).filter((w) => w.length > 1);
    const score = (t) => {
      const name = t.name.toLowerCase().replace(/_/g, " ");
      const description = (t.description ?? "").toLowerCase();
      return words.reduce((sum, w) => sum + (name.includes(w) ? 3 : 0) + (description.includes(w) ? 1 : 0), 0);
    };
    found = tools
      .map((t) => [t, score(t)])
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([t]) => t);
  }
  return found.slice(0, SEARCH_LIMIT);
}

// Streamed reasoning_details arrive in pieces; join pieces of the same block back together.
function mergeDetail(list, piece) {
  const last = list.at(-1);
  const same = last && last.type === piece.type && (last.index ?? 0) === (piece.index ?? 0) && (!piece.id || !last.id || last.id === piece.id);
  if (!same) return void list.push({ ...piece });
  for (const key of ["text", "summary", "data", "signature"]) {
    if (typeof piece[key] === "string") last[key] = (last[key] ?? "") + piece[key];
  }
  for (const [key, value] of Object.entries(piece)) if (!(key in last)) last[key] = value;
}
