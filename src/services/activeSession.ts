import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import { open } from "node:fs/promises";
import path from "node:path";

import { projectsDir as PROJECTS_DIR } from "./paths.js";
const SCAN_INTERVAL_MS = 5_000;
const TAIL_BYTES = 64 * 1024;
const MTIME_WINDOW_MS = 15 * 60_000;
const ROLLING_WINDOW_MS = 30 * 60_000;

type MessageEvent = {
  ts: number;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

export type ActiveSessionSnapshot = {
  activeModel: string | null;
  lastMessageAt: Date | null;
  recent: MessageEvent[];
  fetchedAt: Date;
};

async function readTail(filePath: string, bytes: number): Promise<string> {
  const handle = await open(filePath, "r");
  try {
    const stat = await handle.stat();
    const start = Math.max(0, stat.size - bytes);
    const length = stat.size - start;
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, start);
    return buf.toString("utf8");
  } finally {
    await handle.close();
  }
}

const ANSI_RE = /\[[0-9;]*m/g;
const SET_MODEL_RE = /<local-command-stdout>Set model to ([^<]+)<\/local-command-stdout>/;

function parseLine(line: string, fallbackTs: number): MessageEvent | null {
  try {
    const d = JSON.parse(line);
    const ts = d.timestamp ? new Date(d.timestamp).getTime() : fallbackTs;
    if (d.type === "assistant") {
      const m = d.message;
      if (!m || typeof m.model !== "string" || !m.model.startsWith("claude")) return null;
      const u = m.usage ?? {};
      const input = Number(u.input_tokens ?? 0);
      const output = Number(u.output_tokens ?? 0);
      const cacheRead = Number(u.cache_read_input_tokens ?? 0);
      const cacheWrite = Number(u.cache_creation_input_tokens ?? 0);
      return { ts, model: m.model, input, output, cacheRead, cacheWrite };
    }
    if (d.type === "user" && typeof d.message?.content === "string") {
      const match = SET_MODEL_RE.exec(d.message.content);
      if (!match) return null;
      const model = match[1]!.replace(ANSI_RE, "").trim();
      if (!model) return null;
      return { ts, model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    }
    return null;
  } catch {
    return null;
  }
}

export class ActiveSessionService extends EventEmitter {
  private events: MessageEvent[] = [];
  private seen = new Map<string, number>(); // file path → last size scanned
  private timer?: NodeJS.Timeout;
  private latest?: ActiveSessionSnapshot;
  private lastFingerprint?: string;
  private consumers = new Set<string>();

  /**
   * Register a consumer (typically an action key by `action.id`). When the
   * first consumer registers, a scan runs immediately and the 5 s scan timer
   * starts. While zero consumers are registered the service does no
   * filesystem work.
   */
  acquire(id: string): void {
    const wasEmpty = this.consumers.size === 0;
    this.consumers.add(id);
    if (wasEmpty) {
      void this.scan();
      this.timer = setInterval(() => void this.scan(), SCAN_INTERVAL_MS);
      this.timer.unref();
    }
  }

  release(id: string): void {
    if (!this.consumers.delete(id)) return;
    if (this.consumers.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  releaseAll(): void {
    this.consumers.clear();
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  get snapshot(): ActiveSessionSnapshot | undefined {
    return this.latest;
  }

  private async scan(): Promise<void> {
    const now = Date.now();
    let projects: string[];
    try {
      projects = await fs.readdir(PROJECTS_DIR);
    } catch {
      return;
    }

    const candidates: { file: string; mtimeMs: number; size: number }[] = [];
    await Promise.all(
      projects.map(async (proj) => {
        const dir = path.join(PROJECTS_DIR, proj);
        let files: string[];
        try {
          files = await fs.readdir(dir);
        } catch {
          return;
        }
        await Promise.all(
          files
            .filter((f) => f.endsWith(".jsonl"))
            .map(async (f) => {
              const full = path.join(dir, f);
              try {
                const stat = await fs.stat(full);
                if (now - stat.mtimeMs > MTIME_WINDOW_MS) return;
                candidates.push({ file: full, mtimeMs: stat.mtimeMs, size: stat.size });
              } catch {
                // ignore
              }
            }),
        );
      }),
    );

    for (const c of candidates) {
      const last = this.seen.get(c.file) ?? 0;
      if (c.size === last) continue;
      this.seen.set(c.file, c.size);
      try {
        const text = await readTail(c.file, TAIL_BYTES);
        const lines = text.split("\n");
        // First line may be partial — skip it on subsequent reads, but on first read we still
        // get the freshest entries from the bottom which is what we want.
        for (let i = 1; i < lines.length; i++) {
          const ev = parseLine(lines[i]!, c.mtimeMs);
          if (ev) this.events.push(ev);
        }
      } catch {
        // ignore unreadable
      }
    }

    this.dedupe();
    this.trim(now);
    this.rebuild(now);
  }

  private dedupe(): void {
    const map = new Map<string, MessageEvent>();
    for (const e of this.events) {
      // dedupe by (ts, model, totalTokens) — good enough for our purposes
      const key = `${e.ts}|${e.model}|${e.input}|${e.output}|${e.cacheRead}|${e.cacheWrite}`;
      map.set(key, e);
    }
    this.events = Array.from(map.values()).sort((a, b) => a.ts - b.ts);
  }

  private trim(now: number): void {
    const cutoff = now - ROLLING_WINDOW_MS;
    while (this.events.length && this.events[0]!.ts < cutoff) this.events.shift();
  }

  private rebuild(_now: number): void {
    let mostRecent: MessageEvent | null = null;
    for (const e of this.events) {
      if (!mostRecent || e.ts > mostRecent.ts) mostRecent = e;
    }

    this.latest = {
      activeModel: mostRecent?.model ?? null,
      lastMessageAt: mostRecent ? new Date(mostRecent.ts) : null,
      recent: this.events.slice(-60),
      fetchedAt: new Date(),
    };
    const fingerprint = `${this.latest.activeModel ?? ""}|${this.latest.lastMessageAt?.getTime() ?? 0}`;
    if (fingerprint === this.lastFingerprint) return;
    this.lastFingerprint = fingerprint;
    this.emit("snapshot", this.latest);
  }
}

export const activeSessionService = new ActiveSessionService();
