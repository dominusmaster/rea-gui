// Minimal MCP stdio client: newline-delimited JSON-RPC 2.0 over a child process.
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";

const PROTOCOL_VERSION = "2025-06-18";

export class McpStdioClient extends EventEmitter {
  constructor({ command, args, env, cwd }) {
    super();
    this.command = command;
    this.args = args;
    this.env = env;
    this.cwd = cwd;
    this.nextId = 1;
    this.pending = new Map();
    this.stderrTail = [];
    this.state = "stopped";
    this.serverInfo = null;
    this.error = null;
  }

  async start() {
    this.state = "starting";
    this.error = null;
    this.emit("status");
    this.child = spawn(this.command, this.args, {
      env: this.env,
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let buffer = "";
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) this.#handleLine(line);
      }
    });

    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      for (const line of chunk.split("\n")) {
        if (!line.trim()) continue;
        this.stderrTail.push(line);
        if (this.stderrTail.length > 200) this.stderrTail.shift();
        this.emit("stderr", line);
      }
    });

    const exited = new Promise((_, reject) => {
      this.child.once("error", (err) => reject(err));
      this.child.once("exit", (code, signal) => {
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
        this.request("initialize", {
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
      this.error = err.message;
      this.emit("status");
      this.stop();
      throw err;
    }
  }

  stop() {
    if (this.child && this.child.exitCode === null) this.child.kill();
  }

  #send(message) {
    if (!this.child || this.child.exitCode !== null) {
      throw new Error("REA MCP server is not running");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params, { onProgress } = {}) {
    const id = this.nextId++;
    const message = { jsonrpc: "2.0", id, method };
    if (params !== undefined) message.params = params;
    if (onProgress) {
      message.params = { ...message.params, _meta: { progressToken: id } };
    }
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
    });
    this.#send(message);
    return { id, promise };
  }

  notify(method, params) {
    const message = { jsonrpc: "2.0", method };
    if (params !== undefined) message.params = params;
    this.#send(message);
  }

  cancel(id, reason = "Cancelled from REA GUI") {
    if (!this.pending.has(id)) return false;
    this.notify("notifications/cancelled", { requestId: id, reason });
    const { reject } = this.pending.get(id);
    this.pending.delete(id);
    reject(new Error(reason));
    return true;
  }

  async listTools() {
    const tools = [];
    let cursor;
    do {
      const { promise } = this.request("tools/list", cursor ? { cursor } : {});
      const page = await promise;
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  }

  #handleLine(line) {
    let message;
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
      if (message.error) {
        const err = new Error(message.error.message);
        err.code = message.error.code;
        err.data = message.error.data;
        pending.reject(err);
      } else {
        pending.resolve(message.result);
      }
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
      const pending = this.pending.get(message.params?.progressToken);
      pending?.onProgress?.(message.params);
      return;
    }
    if (message.method === "notifications/message") {
      this.emit("log", message.params);
      return;
    }
    this.emit("notification", message);
  }
}
