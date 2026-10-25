// Chat Completions providers: OpenRouter (any tool-capable model on openrouter.ai) and the
// providers with OpenAI-compatible APIs (OpenAI, Google Gemini, xAI, DeepSeek).
//
// These APIs have no server-side tool search, and REA's ~200 tool schemas are far too
// large to send every turn. So the model gets the agent's starter tools plus a local
// search_tools function; tools it finds are added to the request from then on.
import { ChatSession, type Effort, type SessionOptions } from "./agent.js";
import type { JsonObject, McpTool } from "./types.js";

export type CompatProvider = keyof typeof COMPAT;

/** One model as the browser lists it. */
export interface ListedModel {
  id: string;
  vendor: string;
  label: string;
  note: string;
  reasoning: boolean;
  maxOutput: number | null;
}

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
  extra_content?: unknown;
}

/** A Chat Completions message, plus the reasoning fields some providers add. */
type CompletionMessage =
  | { role: "system" | "user"; content: string }
  | { role: "tool"; tool_call_id: string; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[]; reasoning?: string; reasoning_content?: string; reasoning_details?: ReasoningDetail[] };

interface ReasoningDetail {
  type: string;
  index?: number;
  id?: string;
  text?: string;
  summary?: string;
  data?: string;
  signature?: string;
  [key: string]: unknown;
}

interface StreamedCall {
  id: string;
  name: string;
  args: string;
  extra?: unknown;
}

interface Reply {
  text: string;
  reasoning: string;
  details: ReasoningDetail[];
  calls: StreamedCall[];
  finish: string | null;
}

interface StreamChunk {
  error?: { message?: string };
  choices?: {
    finish_reason?: string | null;
    delta?: {
      content?: string | null;
      reasoning?: string;
      reasoning_content?: string;
      reasoning_details?: ReasoningDetail[];
      tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string }; extra_content?: unknown }[];
    };
  }[];
}

interface OpenRouterModel {
  id: string;
  name?: string;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string };
  supported_parameters?: string[];
  top_provider?: { max_completion_tokens?: number | null };
}

// Per provider: where it lives, and which of its models can chat with tools. Only OpenRouter
// says which models support tools; for the others, ids are filtered to chat models.
interface CompatInfo {
  name: string;
  base: string;
  env: string;
  chat?: RegExp;
  skip?: RegExp;
}

export const COMPAT = {
  openrouter: { name: "OpenRouter", base: "https://openrouter.ai/api/v1", env: "OPENROUTER" },
  openai: { name: "OpenAI", base: "https://api.openai.com/v1", env: "OPENAI", chat: /^(gpt-|o\d|chatgpt-)/, skip: /audio|realtime|transcribe|tts|image|search|instruct|embedding|codex|-\d{4}-\d\d-\d\d$/ },
  gemini: { name: "Google Gemini", base: "https://generativelanguage.googleapis.com/v1beta/openai", env: "GEMINI", chat: /^gemini-/, skip: /embedding|image|tts|audio|live|vision|aqa/ },
  xai: { name: "xAI", base: "https://api.x.ai/v1", env: "XAI", chat: /^grok-/, skip: /image|imagine|vision/ },
  deepseek: { name: "DeepSeek", base: "https://api.deepseek.com/v1", env: "DEEPSEEK", chat: /^deepseek-/ },
} satisfies Record<string, CompatInfo>;
const info = (provider: CompatProvider): CompatInfo => COMPAT[provider];
export const isCompatProvider = (id: string): id is CompatProvider => Object.hasOwn(COMPAT, id);
const BASE_URL = (provider: CompatProvider): string => (process.env[`${COMPAT[provider].env}_BASE_URL`] || COMPAT[provider].base).replace(/\/+$/, "");
export const envKey = (provider: CompatProvider): string | undefined => process.env[`${COMPAT[provider].env}_API_KEY`];
const headers = (provider: CompatProvider): Record<string, string> => (provider === "openrouter" ? { "HTTP-Referer": "https://github.com/dominusmaster/rea-gui", "X-Title": "REA GUI" } : {});
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
const modelCache = new Map<string, { at: number; models: ListedModel[] }>(); // provider + key → { at, models }
const MODEL_TTL = 10 * 60 * 1000;

const perMillion = (price: string | undefined): number | null => {
  const n = Number(price);
  if (!Number.isFinite(n) || n < 0) return null;
  return n * 1e6;
};
const money = (n: number): string => (n === 0 ? "free" : n < 0.1 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`);

// Tool-capable models only: the REA assistant can't work without tool calls.
export async function listModels(provider: CompatProvider, apiKey: string | undefined, { refresh = false } = {}): Promise<ListedModel[]> {
  // OpenRouter's list is public; the others' lists depend on the key, so they're cached per key.
  const cacheKey = provider === "openrouter" ? provider : `${provider}:${apiKey}`;
  const cached = modelCache.get(cacheKey);
  if (!refresh && cached && Date.now() - cached.at < MODEL_TTL) return cached.models;
  if (provider !== "openrouter" && !apiKey) throw new Error(`Add your ${COMPAT[provider].name} API key to see its models.`);
  const query = provider === "openrouter" ? "?supported_parameters=tools" : "";
  const res = await fetch(`${BASE_URL(provider)}/models${query}`, { headers: { ...headers(provider), ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) } });
  if (!res.ok) throw new Error(await errorText(res, provider));
  const { data } = (await res.json()) as { data?: unknown[] };
  const models = provider === "openrouter" ? openRouterModels(data as OpenRouterModel[] | undefined) : directModels(provider, data as { id?: unknown }[] | undefined);
  modelCache.set(cacheKey, { at: Date.now(), models });
  return models;
}

function directModels(provider: CompatProvider, data: { id?: unknown }[] | undefined): ListedModel[] {
  const { chat, skip } = info(provider);
  return (data ?? [])
    .map((m) => String(m.id ?? "").replace(/^models\//, "")) // Gemini prefixes ids with "models/"
    .filter((id) => chat?.test(id) && !skip?.test(id))
    .map((id) => ({ id, label: id, vendor: COMPAT[provider].name, note: "", reasoning: false, maxOutput: null }))
    .sort((a, b) => b.id.localeCompare(a.id, "en", { numeric: true })); // newest versions first
}

function openRouterModels(data: OpenRouterModel[] | undefined): ListedModel[] {
  return (data ?? [])
    // ":batch" variants are for batch jobs, not streamed chat.
    .filter((m) => m.supported_parameters?.includes("tools") && !m.id.endsWith(":batch"))
    .map((m) => {
      const input = perMillion(m.pricing?.prompt);
      const output = perMillion(m.pricing?.completion);
      const price = input === null || output === null ? null : input === 0 && output === 0 ? "free" : `${money(input)} in · ${money(output)} out per 1M tokens`;
      return {
        id: m.id,
        // "Anthropic: Claude Sonnet 5.5" → vendor "Anthropic", label "Claude Sonnet 5.5"
        vendor: (m.name?.includes(": ") ? m.name.split(": ")[0] : m.id.split("/")[0]) ?? m.id,
        label: (m.name ?? m.id).replace(/^[^:]+: /, ""),
        note: [price, m.context_length ? `${Math.round(m.context_length / 1000)}K context` : null].filter(Boolean).join(" · "),
        reasoning: Boolean(m.supported_parameters?.includes("reasoning")),
        maxOutput: m.top_provider?.max_completion_tokens ?? null,
      };
    })
    .sort((a, b) => a.vendor.localeCompare(b.vendor) || a.label.localeCompare(b.label));
}

async function errorText(res: Response, provider: CompatProvider): Promise<string> {
  const name = COMPAT[provider].name;
  const body = await res.text().catch(() => "");
  let message = body.slice(0, 500);
  try {
    const parsed = JSON.parse(body);
    message = parsed.error?.message ?? message;
    const raw = parsed.error?.metadata?.raw;
    if (raw && typeof raw === "string" && !message.includes(raw)) message += ` (${raw.slice(0, 300)})`;
  } catch {}
  // Gemini reports a bad key as 400 rather than 401.
  if (res.status === 401 || res.status === 403 || /api key not valid|invalid api key|incorrect api key/i.test(message)) return `${name} rejected the API key. Check the key and start a new chat.`;
  if (res.status === 402) return provider === "openrouter" ? "Your OpenRouter account is out of credits. Add credits at openrouter.ai/settings/credits, or pick a free model." : `Your ${name} account is out of credits.`;
  if (res.status === 429) return `Rate limited by ${name}. Wait a moment and try again. (${message})`;
  if (res.status === 404 && /tool/i.test(message)) return `No provider for this model supports tool calls on OpenRouter. Pick another model. (${message})`;
  return `${name} error ${res.status}: ${message || res.statusText}`;
}

// ---------- session ----------
export class CompletionsSession extends ChatSession<CompletionMessage> {
  provider: CompatProvider;
  model: string;
  apiKey: string | undefined;
  modelInfo: ListedModel | null;
  // Tools the model can call right now: the agent's starters, plus whatever search_tools finds.
  loaded: Set<string>;
  callSeq = 0;

  /** opts.modelInfo is the entry from listModels, when known. */
  constructor(opts: SessionOptions & { provider: CompatProvider; modelInfo?: ListedModel | null }) {
    super(opts);
    this.provider = opts.provider;
    this.apiKey = opts.apiKey || envKey(this.provider);
    this.model = opts.model || "openrouter/auto";
    this.modelInfo = opts.modelInfo ?? null;
    this.loaded = new Set(this.agentDef.starterTools);
  }

  addUserMessage(text: string): void {
    this.messages.push({ role: "user", content: text });
  }

  #tools() {
    const defs = this.getMcpTools()
      .filter((t) => this.loaded.has(t.name))
      .map((t) => ({ type: "function", function: { name: t.name, description: t.description ?? "", parameters: t.inputSchema ?? { type: "object", properties: {} } } }));
    return [SEARCH_TOOL, ...defs];
  }

  #body(effort: Effort) {
    const maxOutput = Math.min(MAX_OUTPUT, this.modelInfo?.maxOutput ?? MAX_OUTPUT);
    return {
      model: this.model,
      messages: [{ role: "system", content: this.system }, ...this.messages],
      stream: true,
      // Direct providers' output limits vary by model and aren't listed, so they use their defaults.
      ...(this.provider === "openrouter" ? { max_tokens: maxOutput } : {}),
      ...(this.agentDef.usesRea ? { tools: this.#tools() } : {}),
      // Only ask for reasoning where the model supports it; others reject or ignore the field.
      ...(this.modelInfo?.reasoning ? { reasoning: { effort } } : {}),
    };
  }

  async turn(effort: Effort, signal: AbortSignal): Promise<string | null> {
    let finish: string | null = null;
    while (!signal.aborted) {
      if (this.agentDef.usesRea) this.requireRea();
      const reply = await this.#stream(this.#body(effort), signal);
      finish = reply.finish;

      const message: CompletionMessage & { role: "assistant" } = { role: "assistant", content: reply.text || null };
      // Gemini's thought signatures ride in extra_content and must come back with the call.
      if (reply.calls.length) message.tool_calls = reply.calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.args || "{}" }, ...(c.extra ? { extra_content: c.extra } : {}) }));
      // Send reasoning back unchanged so reasoning models can continue across tool calls.
      if (this.provider === "deepseek") {
        if (reply.reasoning) message.reasoning_content = reply.reasoning;
      } else if (this.provider === "openrouter") {
        if (reply.details.length) message.reasoning_details = reply.details;
        else if (reply.reasoning) message.reasoning = reply.reasoning;
      }
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
        let input: JsonObject;
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

  async #callRea(call: StreamedCall, input: JsonObject, signal: AbortSignal): Promise<string> {
    const { text, isError } = await this.runTool(call.id, call.name, input, signal);
    // A tool the model called by name without searching is loaded from now on.
    if (this.getMcpTools().some((t) => t.name === call.name)) this.loaded.add(call.name);
    return isError ? `Error: ${text}` : text;
  }

  // Local tool search: a regex over names and descriptions, falling back to "all keywords match".
  #searchTools(id: string, input: JsonObject): string {
    const query = String(input?.query ?? "").trim();
    this.emit({ type: "tool_search", id });
    this.emit({ type: "tool_search_query", id, input: { query } });
    const found = findTools(this.getMcpTools(), query);
    for (const t of found) this.loaded.add(t.name);
    this.emit({ type: "tool_search_result", id, tools: found.map((t) => t.name) });
    if (!found.length) return `No tools matched "${query}". Try broader keywords or a shorter regex.`;
    return JSON.stringify({
      loaded: found.map((t) => ({ name: t.name, description: (t.description ?? "").split("\n")[0]?.slice(0, 300) ?? "" })),
      note: "These tools are now callable.",
    });
  }

  // Stream one completion, forwarding text and reasoning to the browser as it arrives.
  async #stream(body: object, signal: AbortSignal): Promise<Reply> {
    const { name, env } = info(this.provider);
    if (!this.apiKey) throw new Error(`A ${name} API key is required. Add it in Chat settings, or set ${env}_API_KEY.`);
    const res = await fetch(`${BASE_URL(this.provider)}/chat/completions`, {
      method: "POST",
      headers: { ...headers(this.provider), authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) throw new Error(await errorText(res, this.provider));

    if (!res.body) throw new Error(`${name} sent an empty reply.`);
    const reply: Reply = { text: "", reasoning: "", details: [], calls: [], finish: null };
    const slots = new Map<number, StreamedCall>(); // tool_call index → the call so far
    let open: "text" | "thinking" | null = null; // which block the browser is currently showing
    const show = (kind: "text" | "thinking", text: string) => {
      if (!text) return;
      if (open !== kind) this.emit({ type: kind === "text" ? "text_start" : "thinking_start" });
      open = kind;
      this.emit({ type: kind, text });
    };

    const decoder = new TextDecoder();
    let buffer = "";
    let done = false;
    for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
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
        let event: StreamChunk;
        try {
          event = JSON.parse(data);
        } catch {
          continue;
        }
        if (event.error) throw new Error(`${name} error: ${event.error.message ?? JSON.stringify(event.error)}`);
        const choice = event.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta ?? {};
        // OpenRouter streams reasoning as "reasoning"; DeepSeek and xAI as "reasoning_content".
        const thought = delta.reasoning ?? delta.reasoning_content;
        if (thought) {
          reply.reasoning += thought;
          show("thinking", thought);
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
          const slot: StreamedCall = slots.get(index) ?? { id: "", name: "", args: "" };
          slots.set(index, slot);
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.name ||= tc.function.name;
          if (tc.function?.arguments) slot.args += tc.function.arguments;
          if (tc.extra_content) slot.extra = tc.extra_content;
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
export function findTools(tools: McpTool[], query: string): McpTool[] {
  let found: McpTool[] = [];
  try {
    // Plain words are keywords; only queries using regex syntax are treated as a regex.
    if (!/[|^$*+?()[\]{}\\]/.test(query)) throw new Error("keywords");
    const re = new RegExp(query, "i");
    const byName = tools.filter((t) => re.test(t.name));
    found = [...byName, ...tools.filter((t) => !byName.includes(t) && re.test(t.description ?? ""))];
  } catch {}
  if (!found.length) {
    const words = query.toLowerCase().split(/[^a-z0-9.]+/).filter((w) => w.length > 1);
    const score = (t: McpTool): number => {
      const name = t.name.toLowerCase().replace(/_/g, " ");
      const description = (t.description ?? "").toLowerCase();
      return words.reduce((sum, w) => sum + (name.includes(w) ? 3 : 0) + (description.includes(w) ? 1 : 0), 0);
    };
    found = tools
      .map((t): [McpTool, number] => [t, score(t)])
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([t]) => t);
  }
  return found.slice(0, SEARCH_LIMIT);
}

// Streamed reasoning_details arrive in pieces; join pieces of the same block back together.
function mergeDetail(list: ReasoningDetail[], piece: ReasoningDetail): void {
  const last = list.at(-1);
  const same = last && last.type === piece.type && (last.index ?? 0) === (piece.index ?? 0) && (!piece.id || !last.id || last.id === piece.id);
  if (!same) return void list.push({ ...piece });
  for (const key of ["text", "summary", "data", "signature"] as const) {
    const more = piece[key];
    if (typeof more === "string") last[key] = (last[key] ?? "") + more;
  }
  for (const [key, value] of Object.entries(piece)) if (!(key in last)) last[key] = value;
}
