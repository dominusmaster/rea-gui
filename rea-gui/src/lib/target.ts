// REA keeps one open file ("target"), and many tools act on whatever is open. The guided analysis,
// tool pages and chats all share one REA process, so without coordination one caller can switch the
// file while another is mid-way through inspecting it, and get silently wrong results.
//
// The broker serializes every call that changes or reads the open file, and a caller can name the
// app it means: the broker opens that app first if something else is open.

import type { McpStdioClient } from "./mcp-client.js";
import type { JsonObject, OnProgress, PendingCall, ToolResult } from "./types.js";

/** What binary_session reports about the open file and each tool's availability. */
export interface BinarySession {
  open?: unknown;
  availability?: Record<string, { reason?: string; available?: boolean; remediation?: string }>;
  [key: string]: unknown;
}

export interface CallOptions {
  /** App the caller means; opened first when a target tool runs and another file is open. */
  target?: string | undefined;
  onProgress?: OnProgress | undefined;
}

// Files inside a bundle belong to the bundle: ".../Ghostty.app/Contents/MacOS/ghostty" → ".../Ghostty.app".
export const appKey = (path: unknown): string | null => (typeof path === "string" ? (path.match(/^(.*?\.(?:app|ipa|apk|asar))(?:\/|$)/i)?.[1] ?? path) : null);

const SWITCHES = new Set(["open_binary", "close_binary"]);

export class TargetBroker {
  queue: Promise<unknown> = Promise.resolve();
  open: string | null = null; // app key of the open file, as far as calls through the broker know
  targetTools: Set<string> | null = null; // tools that act on the open file

  // After a REA (re)start nothing is open and the tool list may differ.
  reset(): void {
    this.queue = Promise.resolve();
    this.open = null; // app key of the open file, as far as calls through the broker know
    this.targetTools = null; // tools that act on the open file
  }

  // REA reports "target_required" for tools that need an open file while none is open; learn them then.
  learn(session: BinarySession | null | undefined): void {
    if (!session) return;
    if (!session.open) this.open = null;
    if (session.open || this.targetTools) return;
    const names = Object.entries(session.availability ?? {}).filter(([, a]) => a.reason === "target_required").map(([n]) => n);
    if (names.length) this.targetTools = new Set(names);
  }

  actsOnTarget(name: string): boolean {
    return this.targetTools?.has(name) ?? false;
  }

  /** Run one tool call; it waits its turn when it reads or changes the open file. */
  call(client: McpStdioClient, name: string, args: JsonObject | undefined, { target, onProgress }: CallOptions = {}): PendingCall<ToolResult> {
    let rpcId: number | null = null;
    let cancelled = false;
    const exec = async (): Promise<ToolResult> => {
      if (cancelled) throw new Error("Cancelled before it started");
      if (target && this.actsOnTarget(name) && this.open !== appKey(target)) {
        const opened = await client.request<ToolResult>("tools/call", { name: "open_binary", arguments: { path: target } }).promise;
        if (opened.isError) throw new Error(`Couldn't open ${target} before running ${name}`);
        this.open = appKey(target);
      }
      if (cancelled) throw new Error("Cancelled before it started");
      const req = client.request<ToolResult>("tools/call", { name, arguments: args }, { onProgress });
      rpcId = req.id;
      const result = await req.promise;
      if (!result.isError && name === "open_binary") this.open = appKey(args?.path);
      if (!result.isError && name === "close_binary") this.open = null;
      return result;
    };
    // Calls that neither read nor change the open file (most take an explicit path) run freely.
    const exclusive = SWITCHES.has(name) || this.actsOnTarget(name);
    let promise: Promise<ToolResult>;
    if (exclusive) {
      promise = this.queue.then(exec, exec);
      this.queue = promise.catch(() => {});
    } else {
      promise = exec();
    }
    return {
      promise,
      cancel: () => {
        cancelled = true;
        if (rpcId !== null) client.cancel(rpcId);
      },
    };
  }
}
