// Minimal MCP stdio client: newline-delimited JSON-RPC 2.0 over a child process.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { errorMessage, type McpTool, type OnProgress, type ProgressParams } from "./types.js";

const PROTOCOL_VERSION = "2025-06-18";

export interface McpLaunch {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export type McpState = "stopped" | "starting" | "ready" | "failed";

interface Pending {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
  onProgress: OnProgress | undefined;
}

interface RpcMessage {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: any;
  result?: any;
  error?: { code: number; message: string; data?: unknown };
}

/** An MCP error response, with JSON-RPC's code and data. */
export class McpError extends Error {
  code: number;
  data: unknown;
  constructor(error: { code: number; message: string; data?: unknown }) {
    super(error.message);
    this.code = error.code;
    this.data = error.data;
  }
}

export interface InitializeResult {
  protocolVersion: string;
  serverInfo?: { name: string; version: string };
  instructions?: string;
}

export class McpStdioClient extends EventEmitter {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv | undefined;
  cwd: string | undefined;
  nextId = 1;
  pending = new Map<number | string, Pending>();
  stderrTail: string[] = [];
  state: McpState = "stopped";
  serverInfo: InitializeResult["serverInfo"] | null = null;
  protocolVersion: string | null = null;
  instructions: string | null = null;
  error: string | null = null;
  child: ChildProcessWithoutNullStreams | null = null;

  constructor({ command, args, env, cwd }: McpLaunch) {
    super();
    this.command = command;
    this.args = args;
    this.env = env;
    this.cwd = cwd;
  }

  async start(): Promise<InitializeResult> {
    this.state = "starting";
    this.error = null;
    this.emit("status");
    const child = spawn(this.command, this.args, {
      env: this.env,
      ...(this.cwd ? { cwd: this.cwd } : {}),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) this.#handleLine(line);
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) {
        if (!line.trim()) continue;
        this.stderrTail.push(line);
        if (this.stderrTail.length > 200) this.stderrTail.shift();
        this.emit("stderr", line);
      }
    });

    const exited = new Promise<never>((_, reject) => {
      child.once("error", (err) => reject(err));
      child.once("exit", (code, signal) => {
        const err = new Error(`REA MCP server exited (code ${code}, signal ${signal})`);
        this.state = "stopped";
        this.error = err.message;
        for (const { reject: rejectPending } of this.pending.values()) rejectPending(err);
        this.pending.clear();
        this.emit("status");
        reject(err);
      });
    });
    exited.catch(() => {});

    try {
      const result = await Promise.race([
        this.request<InitializeResult>("initialize", {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "rea-gui", version: "0.1.0" },
        }).promise,
        exited,
      ]);
      this.serverInfo = result.serverInfo ?? null;
      this.protocolVersion = result.protocolVersion;
      this.instructions = result.instructions ?? null;
      this.notify("notifications/initialized");
      this.state = "ready";
      this.emit("status");
      return result;
    } catch (err) {
      this.state = "failed";
      this.error = errorMessage(err);
      this.emit("status");
      this.stop();
      throw err;
    }
  }

  stop(): void {
    if (this.child && this.child.exitCode === null) this.child.kill();
  }

  #send(message: RpcMessage): void {
    if (!this.child || this.child.exitCode !== null) {
      throw new Error("REA MCP server is not running");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request<T = any>(method: string, params?: object, { onProgress }: { onProgress?: OnProgress | undefined } = {}): { id: number; promise: Promise<T> } {
    const id = this.nextId++;
    const message: RpcMessage = { jsonrpc: "2.0", id, method };
    if (params !== undefined) message.params = params;
    if (onProgress) {
      message.params = { ...message.params, _meta: { progressToken: id } };
    }
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
    });
    this.#send(message);
    return { id, promise };
  }

  notify(method: string, params?: object): void {
    const message: RpcMessage = { jsonrpc: "2.0", method };
    if (params !== undefined) message.params = params;
    this.#send(message);
  }

  cancel(id: number, reason = "Cancelled from REA GUI"): boolean {
    const pending = this.pending.get(id);
    if (!pending) return false;
    this.notify("notifications/cancelled", { requestId: id, reason });
    this.pending.delete(id);
    pending.reject(new Error(reason));
    return true;
  }

  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.request<{ tools: McpTool[]; nextCursor?: string }>("tools/list", cursor ? { cursor } : {}).promise;
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  }

  #handleLine(line: string): void {
    let message: RpcMessage;
    try {
      message = JSON.parse(line);
    } catch {
      this.emit("stderr", `[non-JSON stdout] ${line}`);
      return;
    }

    // Response to one of our requests.
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new McpError(message.error));
      else pending.resolve(message.result);
      return;
    }

    // Server-initiated request: we advertise no client capabilities.
    if (message.id !== undefined && message.method) {
      if (message.method === "ping") {
        this.#send({ jsonrpc: "2.0", id: message.id, result: {} });
      } else {
        this.#send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: `Method not supported by rea-gui: ${message.method}` },
        });
      }
      return;
    }

    if (message.method === "notifications/progress") {
      const params = message.params as ProgressParams | undefined;
      const pending = params?.progressToken === undefined ? undefined : this.pending.get(params.progressToken);
      if (params) pending?.onProgress?.(params);
      return;
    }
    if (message.method === "notifications/message") {
      this.emit("log", message.params);
      return;
    }
    this.emit("notification", message);
  }
}
