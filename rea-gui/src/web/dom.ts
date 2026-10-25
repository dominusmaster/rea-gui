// Shared browser types and the tiny DOM helper every page is built with.

/**
 * REA's JSON output. Its shape depends on the tool and REA version, so it is read defensively
 * (optional chaining, fallbacks) rather than described here. REA's own TypeScript types are the
 * reference for any one tool's result.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ReaData = any;

/** An input, select or textarea event; their targets all have a value. */
export type FieldEvent = Event & { target: HTMLInputElement };

export type Child = Node | string | number | null | undefined | false | Child[];

export interface Props {
  class?: string | undefined;
  text?: string | number | null | undefined;
  onclick?: ((e: MouseEvent) => unknown) | undefined;
  oninput?: ((e: FieldEvent) => unknown) | undefined;
  onchange?: ((e: FieldEvent) => unknown) | undefined;
  onkeydown?: ((e: KeyboardEvent) => unknown) | undefined;
  onsubmit?: ((e: SubmitEvent) => unknown) | undefined;
  [attribute: string]: unknown;
}

/** Create an element. Text is always set as text, never parsed as HTML. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props | null, ...children: Child[]): HTMLElementTagNameMap[K];
export function h(tag: string, props?: Props | null, ...children: Child[]): HTMLElement;
export function h(tag: string, props: Props | null = {}, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") el.className = String(value);
    else if (key === "text") el.textContent = String(value);
    else if (key.startsWith("on")) el.addEventListener(key.slice(2), value as EventListener);
    else if (key in el && typeof value !== "string") (el as unknown as Record<string, unknown>)[key] = value;
    else el.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of (children as unknown[]).flat(Infinity) as Child[]) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

/** The first element matching a selector the page always contains. */
export const $ = <T extends HTMLElement = HTMLElement>(selector: string): T => {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`Missing element ${selector}`);
  return el;
};

/** An REA tool as the server lists it. */
export interface Tool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: ReaData;
  annotations?: ReaData;
}

/** A finished (or running) tool call, as the server reports it. */
export interface CallRecord {
  id?: string | undefined;
  name: string;
  arguments?: ReaData;
  state: "running" | "done" | "error";
  startedAt?: number | undefined;
  finishedAt?: number | undefined;
  progress?: ReaData;
  result?: ReaData;
  error?: { message: string; code?: number; data?: unknown } | undefined;
  /** Added by the guided analysis: the file list it fetched separately. */
  inventory?: ReaData;
}

export type JsonTree = (value: ReaData, openDepth?: number) => HTMLElement;
export type StartCall = (
  name: string,
  args: ReaData,
  onProgress?: (progress: ReaData) => void,
  target?: string,
) => Promise<{ callId: string; done: Promise<CallRecord> }>;

/** What the evidence renderers need from the app. */
export interface EvidenceContext {
  h: typeof h;
  jsonTree: JsonTree;
  callAndWait: (name: string, args: ReaData) => Promise<CallRecord>;
  viewTool: Tool | undefined;
  drill: (title: string, args: ReaData) => void;
  renderFailure: (record: CallRecord, parsed: ReaData) => HTMLElement;
  inDrill?: boolean;
}

/** The type of h, for code that receives it as a parameter. */
export type H = typeof h;

export const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The first element matching a selector that only some pages have, or null. */
export const $opt = <T extends HTMLElement = HTMLElement>(selector: string): T | null => document.querySelector<T>(selector);
