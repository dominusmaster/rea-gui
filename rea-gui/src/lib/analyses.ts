// Saved guided analyses: one JSON file per analysis plus a small index, so the sidebar lists
// them without reading every (possibly multi-megabyte) result file.
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** A saved analysis: the browser's snapshot, kept as-is. */
export interface AnalysisSnapshot {
  id: string;
  path: string;
  at: number;
  [key: string]: unknown;
}
export type AnalysisSummary = Record<(typeof SUMMARY_KEYS)[number], unknown> & { id: string; path: string; at: number };

const ID = /^a[0-9a-z]{4,24}$/;
const KEEP = 50;
const SUMMARY_KEYS = ["id", "path", "name", "kind", "at", "state", "finishedAt", "failedChecks"] as const;

export class AnalysisStore {
  dir: string;
  index: AnalysisSummary[] | null = null;
  // Writes run one at a time so the index never loses an update.
  queue: Promise<unknown> = Promise.resolve();

  constructor(dir: string) {
    this.dir = dir;
  }

  static validId(id: unknown): id is string {
    return typeof id === "string" && ID.test(id);
  }

  async list(): Promise<AnalysisSummary[]> {
    if (!this.index) {
      try {
        this.index = JSON.parse(await readFile(join(this.dir, "index.json"), "utf8")) as AnalysisSummary[];
      } catch {
        this.index = [];
      }
    }
    return this.index ?? [];
  }

  async get(id: unknown): Promise<AnalysisSnapshot | null> {
    if (!AnalysisStore.validId(id)) return null;
    try {
      return JSON.parse(await readFile(this.file(id), "utf8"));
    } catch {
      return null;
    }
  }

  save(snapshot: AnalysisSnapshot): Promise<AnalysisSummary> {
    return this.serial(async () => {
      const summary = Object.fromEntries(SUMMARY_KEYS.map((k) => [k, snapshot[k] ?? null])) as AnalysisSummary;
      await mkdir(this.dir, { recursive: true });
      await atomicWrite(this.file(snapshot.id), JSON.stringify(snapshot));
      // A path keeps only its latest analysis, newest first.
      const index = await this.list();
      const replaced = index.filter((s) => s.id !== snapshot.id && s.path === snapshot.path);
      const rest = index.filter((s) => s.id !== snapshot.id && s.path !== snapshot.path);
      const dropped = [...replaced, ...rest.slice(KEEP - 1)];
      this.index = [summary, ...rest.slice(0, KEEP - 1)].sort((a, b) => b.at - a.at);
      await atomicWrite(join(this.dir, "index.json"), JSON.stringify(this.index));
      await Promise.all(dropped.map((s) => rm(this.file(s.id), { force: true })));
      return summary;
    });
  }

  remove(id: string): Promise<boolean> {
    return this.serial(async () => {
      const index = await this.list();
      if (!index.some((s) => s.id === id)) return false;
      this.index = index.filter((s) => s.id !== id);
      await atomicWrite(join(this.dir, "index.json"), JSON.stringify(this.index));
      await rm(this.file(id), { force: true });
      return true;
    });
  }

  file(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task);
    this.queue = run.catch(() => {});
    return run;
  }
}

// Write to a temp file first so a crash mid-write never leaves a truncated result.
async function atomicWrite(path: string, text: string): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, path);
}
