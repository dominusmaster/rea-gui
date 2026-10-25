// Shared by the end-to-end tests.

/** JSON from the server under test or sent to a fake provider; each test asserts the parts it reads. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The per-launch API token embedded in the served page. */
export function pageToken(html: string | null | undefined): string {
  const token = html?.match(/name="rea-gui-token" content="([0-9a-f]+)"/)?.[1];
  if (!token) throw new Error("The page has no API token");
  return token;
}

/** Calls the REA GUI API with the page token; returns the status and parsed body. */
export const apiClient =
  (base: string, token: string) =>
  (path: string, init: RequestInit = {}): Promise<{ status: number; body: Json }> =>
    fetch(base + path, { ...init, headers: { "x-rea-gui-token": token, "content-type": "application/json" } }).then(async (r) => ({ status: r.status, body: await r.json() }));

/** A value the test expects to exist; fails with a clear message when it doesn't. */
export function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`Expected ${what}`);
  return value;
}

/** The port a test server listens on. */
export function portOf(server: import("node:net").Server): number {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server isn't listening on a port");
  return address.port;
}

/** Reads a chat stream's first "reset" event: the chat so far. */
export async function readReset(url: string): Promise<Json> {
  const stream = await fetch(url);
  const reader = must(stream.body, "a stream body").getReader();
  const { value } = await reader.read();
  reader.cancel();
  return JSON.parse(must(new TextDecoder().decode(value).match(/event: reset\ndata: (.*)\n/)?.[1], "a reset event"));
}
