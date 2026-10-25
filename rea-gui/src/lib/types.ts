// Shapes of the MCP data REA sends, shared by the server modules. REA's own types live in its
// TypeScript source; these cover only the parts REA GUI reads.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: JsonObject;
  outputSchema?: JsonObject;
  annotations?: McpToolAnnotations;
}

export interface McpContent {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface ToolResult {
  content?: McpContent[];
  structuredContent?: unknown;
  isError?: boolean;
}

export interface ProgressParams {
  progressToken?: number | string;
  progress?: number;
  total?: number;
  message?: string;
}

export type OnProgress = (params: ProgressParams) => void;

/** A request in flight: its JSON-RPC id, its result, and a way to stop it. */
export interface PendingCall<T> {
  promise: Promise<T>;
  cancel: () => void;
}

export const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
