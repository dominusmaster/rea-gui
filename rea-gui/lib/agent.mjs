// Chat agent: a model drives REA's MCP tools. ChatSession holds what every provider shares
// (approvals, stopping, running REA tools); AnthropicSession talks to Claude through the
// Messages API, and OpenRouterSession (openrouter.mjs) to any tool-capable OpenRouter model.
//
// For Claude, REA advertises ~200 tools (~770 KB of schemas), so every tool is sent with
// defer_loading and Claude finds what it needs with server-side tool search.
// A few starter tools per agent stay loaded so common first steps need no search.
// The loop is manual (not the SDK tool runner) because each turn streams to the
// browser and state-changing tools pause for the user's approval.
import Anthropic from "@anthropic-ai/sdk";

export const MODELS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5", note: "Recommended for multi-step analysis", fallbacks: true },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", note: "Faster and cheaper", fallbacks: true },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", note: "Fastest, for quick lookups", fallbacks: false },
  { id: "claude-fable-5-1", label: "Claude Fable 5.1", note: "Most capable, highest cost", fallbacks: true },
];
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
export const DEFAULT_EFFORT = "high";

// Tool results larger than this are cut short before they reach the model.
const MAX_RESULT_CHARS = 60_000;

const BASE_PROMPT = `You are a reverse-engineering assistant inside REA Studio, running on the user's own computer. You work through REA ("Reverse Engineer Anything"), which analyzes apps and binaries statically, without executing them.

Most REA tools aren't loaded up front. Find them with the tool search tool: it takes a Python regex over tool names and descriptions. REA tool names are snake_case verbs, for example analyze_javascript_application, open_binary, inspect_macho, inspect_signature, inspect_electron_fuses, inspect_artifact, project_android_application_graph, identify_flutter_build, inspect_managed_artifact, inspect_analysis_view, list_adb_devices.

How REA works:
- REA keeps one active target. Tools such as inspect_macho, inspect_signature and inspect_artifact act on the file most recently opened with open_binary, so open the file first.
- Use detail: "summary" when a tool offers it. Results can be very large; oversized results are cut short and say so. Page through retained evidence with inspect_analysis_view and the evidence_id instead of re-running a heavy tool.
- When an error includes a remediation (for example "rerun ... with integrity_policy=record-and-continue"), follow it.
- Some tools need helper software that isn't installed. If a tool reports that, tell the user what's missing and carry on with what works.
- Tools that change state (devices, debuggers, annotations) wait for the user's approval. If the user declines, don't retry the call; ask what they want instead.

Ground every claim in tool output, cite file paths, locations or evidence ids, and say when coverage is partial. Keep answers concise and use Markdown.`;

export const AGENTS = [
  {
    id: "rea-assistant",
    label: "REA Assistant",
    description: "Reverse-engineering assistant that drives REA's tools",
    system: BASE_PROMPT,
    usesRea: true,
    starterTools: ["open_binary", "binary_session", "inspect_macho", "inspect_signature", "inspect_artifact", "inspect_analysis_view"],
  },
  {
    id: "general",
    label: "General Chat",
    description: "General-purpose chat, no REA tools",
    system: "You are a helpful assistant. Keep answers concise and use Markdown.",
    usesRea: false,
    starterTools: [],
  },
];

export const PROVIDERS = [
  { id: "anthropic", label: "Anthropic", keyLabel: "Anthropic API key", keyPlaceholder: "sk-ant-…", keyEnv: "ANTHROPIC_API_KEY" },
  { id: "openrouter", label: "OpenRouter", keyLabel: "OpenRouter API key", keyPlaceholder: "sk-or-…", keyEnv: "OPENROUTER_API_KEY" },
];

export const publicAgents = () => AGENTS.map(({ id, label, description, usesRea }) => ({ id, label, description, usesRea }));

// State-changing REA tools wait for the user. REA marks them destructive or non-idempotent.
export function needsApproval(tool) {
  const a = tool?.annotations ?? {};
  return a.destructiveHint === true || a.idempotentHint === false;
}

// Server-side tool search plus every MCP tool; all but the starters are deferred.
function buildTools(mcpTools, starterNames) {
  return [
    { type: "tool_search_tool_regex_20251119", name: "tool_search_tool_regex" },
    ...mcpTools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      input_schema: t.inputSchema ?? { type: "object", properties: {} },
      ...(starterNames.includes(t.name) ? {} : { defer_loading: true }),
    })),
  ];
}

export function resultText(mcpResult) {
  const parts = [];
  for (const c of mcpResult.content ?? []) {
    if (c.type === "text") parts.push(c.text);
    else if (c.type === "resource" && c.resource?.text) parts.push(c.resource.text);
    else parts.push(`[${c.type} content omitted]`);
  }
  if (!parts.length && mcpResult.structuredContent) parts.push(JSON.stringify(mcpResult.structuredContent));
  let text = parts.join("\n") || "(no output)";
  if (text.length > MAX_RESULT_CHARS) {
    text = `${text.slice(0, MAX_RESULT_CHARS)}\n\n[Result truncated: showing ${MAX_RESULT_CHARS} of ${text.length} characters. Use inspect_analysis_view with the evidence_id to page through the rest.]`;
  }
  return text;
}

function describeAnthropicError(err) {
  if (err instanceof Anthropic.AuthenticationError) return "The Anthropic API key was rejected. Check the key and start a new chat.";
  if (err instanceof Anthropic.PermissionDeniedError) return `This API key can't use that model or feature: ${err.message}`;
  if (err instanceof Anthropic.RateLimitError) return "Rate limited by the Anthropic API. Wait a moment and try again.";
  if (err instanceof Anthropic.APIConnectionError) return "Couldn't reach the Anthropic API. Check your network connection.";
  return err?.message ?? String(err);
}

// One conversation. Subclasses implement turn(effort, signal), which appends to this.messages
// and calls runTool for each tool call; the history is append-only so reasoning stays valid.
export class ChatSession {
  /**
   * @param {object} opts
   * @param {() => import("./mcp-client.mjs").McpStdioClient | undefined} opts.getMcpClient
   * @param {() => any[]} opts.getMcpTools
   * @param {(event: object) => void} opts.onEvent
   */
  constructor({ agent, context, target, callTool, getMcpClient, getMcpTools, onEvent }) {
    this.agentDef = AGENTS.find((a) => a.id === agent) ?? AGENTS[0];
    this.agent = this.agentDef.id;
    // Fixed for the session's lifetime so the system prompt stays cacheable.
    this.system = context ? `${this.agentDef.system}\n\n${context}` : this.agentDef.system;
    this.getMcpClient = getMcpClient;
    this.target = target; // app this chat is about, if any
    this.callTool = callTool;
    this.getMcpTools = getMcpTools;
    this.onEvent = onEvent;
    this.messages = [];
    this.busy = false;
    this.title = null;
    this.controller = null;
    this.approvals = new Map(); // tool call id → resolve(boolean)
    this.activeCall = null; // { cancel } for the running tool call
  }

  emit(event) {
    this.onEvent?.(event);
  }

  abort() {
    if (!this.busy) return;
    this.controller?.abort();
    for (const resolve of this.approvals.values()) resolve(false);
    this.approvals.clear();
    this.activeCall?.cancel();
  }

  approve(toolUseId, approved) {
    const resolve = this.approvals.get(toolUseId);
    if (!resolve) return false;
    this.approvals.delete(toolUseId);
    resolve(Boolean(approved));
    return true;
  }

  requireRea() {
    if (this.getMcpClient()?.state !== "ready") throw new Error("REA is not running. Restart REA and try again.");
  }

  // Run one user turn: the subclass streams replies and runs tools until the model finishes.
  async run(userMessage, { effort = DEFAULT_EFFORT } = {}) {
    if (this.busy) throw new Error("A reply is already in progress");
    if (!EFFORTS.includes(effort)) effort = DEFAULT_EFFORT;
    this.busy = true;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    this.title ??= userMessage.slice(0, 60);
    this.addUserMessage(userMessage);
    this.emit({ type: "user", text: userMessage });
    this.emit({ type: "turn_start" });

    let stopReason = null;
    try {
      stopReason = await this.turn(effort, signal);
      if (signal.aborted) this.emit({ type: "aborted" });
    } catch (err) {
      if (signal.aborted || err?.name === "AbortError" || err instanceof Anthropic.APIUserAbortError) this.emit({ type: "aborted" });
      else this.emit({ type: "error", message: this.describeError(err) });
    } finally {
      this.busy = false;
      this.controller = null;
      this.activeCall = null;
      this.emit({ type: "turn_end", stopReason });
    }
  }

  describeError(err) {
    return err?.message ?? String(err);
  }

  // Run one REA tool call (asking first if it changes state). Never throws: failures become error results.
  async runTool(id, name, input, signal) {
    const fail = (text) => ({ text, isError: true });
    const tool = this.getMcpTools().find((t) => t.name === name);
    this.emit({ type: "tool_start", id, name, input });
    if (signal.aborted) {
      this.emit({ type: "tool_end", id, isError: true, result: "Stopped by the user." });
      return fail("Stopped by the user before this tool ran.");
    }
    if (!tool) {
      this.emit({ type: "tool_end", id, isError: true, result: "Unknown tool" });
      return fail(`Unknown tool ${name}. Use the tool search tool to find available tools.`);
    }
    if (needsApproval(tool)) {
      this.emit({ type: "approval", id, name });
      const approved = await new Promise((resolve) => this.approvals.set(id, resolve));
      this.emit({ type: "approval_result", id, approved });
      if (!approved) {
        this.emit({ type: "tool_end", id, isError: true, result: "Declined by the user." });
        return fail("The user declined to run this tool. Don't retry it; ask the user what they want instead.");
      }
    }

    const mcp = this.getMcpClient();
    if (mcp?.state !== "ready") {
      this.emit({ type: "tool_end", id, isError: true, result: "REA is not running." });
      return fail("REA is not running, so the tool couldn't be called.");
    }
    try {
      // Through the server's broker when available, so this chat can't read or switch another caller's open file.
      const { promise, cancel } = this.callTool
        ? this.callTool(name, input ?? {}, { target: this.target })
        : (({ id: requestId, promise }) => ({ promise, cancel: () => mcp.cancel(requestId) }))(mcp.request("tools/call", { name, arguments: input ?? {} }));
      this.activeCall = { cancel };
      const result = await promise;
      const text = resultText(result);
      this.emit({ type: "tool_end", id, isError: Boolean(result.isError), result: text.slice(0, 8000) });
      return { text, isError: Boolean(result.isError) };
    } catch (err) {
      const msg = signal.aborted ? "Stopped by the user." : err.message ?? String(err);
      this.emit({ type: "tool_end", id, isError: true, result: msg });
      return fail(msg);
    } finally {
      this.activeCall = null;
    }
  }
}

export class AnthropicSession extends ChatSession {
  /** @param {object} opts  opts.apiKey falls back to ANTHROPIC_API_KEY / an `ant auth login` profile. */
  constructor(opts) {
    super(opts);
    this.provider = "anthropic";
    this.client = new Anthropic(opts.apiKey ? { apiKey: opts.apiKey } : {});
    this.model = MODELS.some((m) => m.id === opts.model) ? opts.model : MODELS[0].id;
  }

  addUserMessage(text) {
    this.messages.push({ role: "user", content: text });
  }

  describeError(err) {
    return describeAnthropicError(err);
  }

  #requestParams(effort, tools) {
    const modelInfo = MODELS.find((m) => m.id === this.model);
    return {
      model: this.model,
      max_tokens: 64000,
      system: this.system,
      messages: this.messages,
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort },
      cache_control: { type: "ephemeral" },
      ...(tools ? { tools } : {}),
      // Route a safety decline to a fallback model instead of ending the turn.
      ...(modelInfo?.fallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {}),
    };
  }

  async turn(effort, signal) {
    let stopReason = null;
    while (!signal.aborted) {
      let tools;
      if (this.agentDef.usesRea) {
        this.requireRea();
        tools = buildTools(this.getMcpTools(), this.agentDef.starterTools);
      }

      const stream = this.client.beta.messages.stream(this.#requestParams(effort, tools), { signal });
      stream.on("streamEvent", (event) => {
        if (event.type === "content_block_start") {
          const block = event.content_block;
          if (block.type === "text") this.emit({ type: "text_start" });
          else if (block.type === "thinking") this.emit({ type: "thinking_start" });
          else if (block.type === "server_tool_use") this.emit({ type: "tool_search", id: block.id });
        } else if (event.type === "content_block_delta") {
          if (event.delta.type === "text_delta") this.emit({ type: "text", text: event.delta.text });
          else if (event.delta.type === "thinking_delta") this.emit({ type: "thinking", text: event.delta.thinking });
        }
      });
      const message = await stream.finalMessage();
      this.messages.push({ role: "assistant", content: message.content });
      stopReason = message.stop_reason;

      for (const block of message.content) {
        if (block.type === "server_tool_use") this.emit({ type: "tool_search_query", id: block.id, input: block.input });
        if (block.type === "tool_search_tool_result") {
          const refs = block.content?.tool_references ?? [];
          this.emit({ type: "tool_search_result", id: block.tool_use_id, tools: refs.map((r) => r.tool_name) });
        }
        if (block.type === "fallback") this.emit({ type: "notice", text: `${block.from?.model} declined; ${block.to?.model} continued.` });
      }

      if (stopReason === "pause_turn") continue; // a server tool paused a long turn; resend to resume
      if (stopReason === "refusal") {
        const why = message.stop_details?.explanation ?? message.stop_details?.category ?? "";
        this.emit({ type: "error", message: `Claude declined this request${why ? `: ${why}` : "."}` });
        break;
      }
      const calls = message.content.filter((b) => b.type === "tool_use");
      if (stopReason === "max_tokens") {
        this.emit({ type: "error", message: "The reply hit the output limit and was cut short." });
        if (calls.length) this.messages.push({ role: "user", content: calls.map((c) => ({ type: "tool_result", tool_use_id: c.id, content: "Not run: the tool call was cut off by the output limit.", is_error: true })) });
        break;
      }
      if (stopReason !== "tool_use" || !calls.length) break;

      // Every tool_use needs a matching tool_result, even when stopped or declined.
      const results = [];
      for (const call of calls) {
        const { text, isError } = await this.runTool(call.id, call.name, call.input, signal);
        results.push({ type: "tool_result", tool_use_id: call.id, content: text, ...(isError ? { is_error: true } : {}) });
      }
      this.messages.push({ role: "user", content: results });
    }
    return stopReason;
  }
}

// Earlier name, kept for callers that construct a Claude session directly.
export const AgentSession = AnthropicSession;
