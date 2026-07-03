import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import { open } from "node:fs/promises";

import {
  acknowledgeSessions,
  applyEvent,
  ATTENTION_POLL_MS,
  type AttentionSnapshot,
  type AttentionState,
  EVENTS_ROTATE_BYTES,
  EVENTS_TAIL_BYTES,
  expireSessions,
  hooksInstalled,
  mergeAttentionHooks,
  parseAttentionLine,
  ROTATE_GRACE_MS,
  type SessionAttention,
  SETTINGS_CHECK_MS,
  snapshotFingerprint,
  splitCompleteLines,
  toSnapshot,
} from "./attentionPolicy.js";
import {
  attentionEventsJsonl as EVENTS_FILE,
  attentionEventsRotated as ROTATED_FILE,
  claudeSettingsJson as SETTINGS_FILE,
  siestadeckClaudeDir,
} from "./paths.js";
import { isWindows } from "./platform.js";

export type { AttentionSnapshot, AttentionState } from "./attentionPolicy.js";

const PLATFORM: "mac" | "windows" = isWindows ? "windows" : "mac";

async function readRange(filePath: string, start: number, end: number): Promise<string> {
  const handle = await open(filePath, "r");
  try {
    const length = Math.max(0, end - start);
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, start);
    return buf.toString("utf8");
  } finally {
    await handle.close();
  }
}

/**
 * Lazy, reference-counted watcher over the attention events file that the
 * installed Claude Code hooks append to. Same lifecycle contract as
 * ActiveSessionService: the 1s poll runs only while at least one Attention
 * key is visible.
 */
export class AttentionService extends EventEmitter {
  private sessions = new Map<string, SessionAttention>();
  private timer?: NodeJS.Timeout;
  private latest?: AttentionSnapshot;
  private lastFingerprint?: string;
  private consumers = new Set<string>();

  // events-file cursor
  private offset = 0;
  private carry = "";
  private firstRead = true;
  /** Set while a renamed-out file may still receive straggler hook writes. */
  private rotated?: { offset: number; carry: string; deadline: number };

  // settings.json install check (mtime-gated, every SETTINGS_CHECK_MS)
  private hooksOk = false;
  private settingsCheckedAt = 0;
  private settingsMtime = -1;

  acquire(id: string): void {
    const wasEmpty = this.consumers.size === 0;
    this.consumers.add(id);
    if (wasEmpty) {
      void this.tick();
      this.timer = setInterval(() => void this.tick(), ATTENTION_POLL_MS);
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

  get snapshot(): AttentionSnapshot | undefined {
    return this.latest;
  }

  /** Acknowledge every session currently in one of `states` (all keys share ack state). */
  acknowledge(states: readonly AttentionState[]): void {
    if (acknowledgeSessions(this.sessions, states)) this.publish();
  }

  /**
   * Merge the attention hooks into ~/.claude/settings.json. Throws when the
   * existing file is unparseable (never clobber a file we can't read) —
   * callers surface that via showAlert(). A pre-write backup is kept at
   * settings.json.siestadeck.bak.
   */
  async installHooks(): Promise<void> {
    let settings: Record<string, unknown> = {};
    let raw: string | null = null;
    try {
      raw = await fs.readFile(SETTINGS_FILE, "utf8");
    } catch {
      raw = null; // missing file → install into fresh {}
    }
    if (raw != null) {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("settings.json is not a JSON object");
      }
      settings = parsed as Record<string, unknown>;
      await fs.writeFile(SETTINGS_FILE + ".siestadeck.bak", raw, "utf8");
    }
    const merged = mergeAttentionHooks(settings, PLATFORM);
    await fs.mkdir(siestadeckClaudeDir, { recursive: true });
    await fs.writeFile(SETTINGS_FILE, JSON.stringify(merged, null, 2) + "\n", "utf8");
    this.hooksOk = true;
    this.settingsMtime = -1; // force a real re-check on the next settings tick
    this.publish();
  }

  private async tick(): Promise<void> {
    try {
      const now = Date.now();
      await this.checkSettings(now);
      await this.drainRotated(now);
      await this.readEvents(now);
      await this.maybeRotate(now);
      expireSessions(this.sessions, now);
      this.publish();
    } catch {
      // never let a poll tick reject unhandled
    }
  }

  private async checkSettings(now: number): Promise<void> {
    if (now - this.settingsCheckedAt < SETTINGS_CHECK_MS && this.settingsCheckedAt !== 0) return;
    this.settingsCheckedAt = now;
    try {
      const stat = await fs.stat(SETTINGS_FILE);
      if (stat.mtimeMs === this.settingsMtime) return;
      this.settingsMtime = stat.mtimeMs;
      const parsed: unknown = JSON.parse(await fs.readFile(SETTINGS_FILE, "utf8"));
      this.hooksOk = hooksInstalled(parsed);
    } catch {
      this.hooksOk = false;
      this.settingsMtime = -1;
    }
  }

  private applyChunk(chunk: string, ts: number, isRotated: boolean): void {
    const carryIn = isRotated ? this.rotated!.carry : this.carry;
    const { lines, carry } = splitCompleteLines(chunk, carryIn);
    if (isRotated) this.rotated!.carry = carry;
    else this.carry = carry;
    for (const line of lines) {
      const ev = parseAttentionLine(line);
      if (ev) applyEvent(this.sessions, ev, ts);
    }
  }

  private async readEvents(now: number): Promise<void> {
    let stat;
    try {
      stat = await fs.stat(EVENTS_FILE);
    } catch {
      // no events yet (or freshly rotated with no straggler-free file yet)
      this.offset = 0;
      this.carry = "";
      this.firstRead = false;
      return;
    }
    if (stat.size < this.offset) {
      // externally truncated/replaced — start over
      this.offset = 0;
      this.carry = "";
    }
    if (stat.size === this.offset) return;

    let start = this.offset;
    let ts = now;
    if (this.firstRead) {
      // Cold start: replay at most the last EVENTS_TAIL_BYTES with the file
      // mtime as timestamp (order-correct state, imprecise `since`).
      ts = stat.mtimeMs;
      if (stat.size > EVENTS_TAIL_BYTES) {
        start = stat.size - EVENTS_TAIL_BYTES;
        const text = await readRange(EVENTS_FILE, start, stat.size);
        // drop the leading partial line
        const nl = text.indexOf("\n");
        this.applyChunk(nl >= 0 ? text.slice(nl + 1) : "", ts, false);
        this.offset = stat.size;
        this.firstRead = false;
        return;
      }
    }
    const text = await readRange(EVENTS_FILE, start, stat.size);
    this.applyChunk(text, ts, false);
    this.offset = stat.size;
    this.firstRead = false;
  }

  /**
   * Rotate by rename once the file grows past EVENTS_ROTATE_BYTES. Hook
   * commands open by path per invocation, so post-rename appends land in a
   * fresh events file; a hook that had already opened the old path keeps
   * writing to the renamed file, which we drain for ROTATE_GRACE_MS before
   * deleting it. No events are lost, unlike truncate-in-place.
   */
  private async maybeRotate(now: number): Promise<void> {
    if (this.rotated || this.offset < EVENTS_ROTATE_BYTES) return;
    try {
      await fs.rename(EVENTS_FILE, ROTATED_FILE);
    } catch {
      return; // e.g. Windows sharing violation — retry next tick
    }
    this.rotated = { offset: this.offset, carry: this.carry, deadline: now + ROTATE_GRACE_MS };
    this.offset = 0;
    this.carry = "";
  }

  private async drainRotated(now: number): Promise<void> {
    if (!this.rotated) return;
    try {
      const stat = await fs.stat(ROTATED_FILE);
      if (stat.size > this.rotated.offset) {
        const text = await readRange(ROTATED_FILE, this.rotated.offset, stat.size);
        this.rotated.offset = stat.size;
        this.applyChunk(text, now, true);
      }
    } catch {
      // already gone — fall through to cleanup
    }
    if (now >= this.rotated.deadline) {
      try {
        await fs.unlink(ROTATED_FILE);
      } catch {
        // ignore; leftover .old is harmless and retried on next rotation
      }
      this.rotated = undefined;
    }
  }

  private publish(): void {
    const snap = toSnapshot(this.sessions, this.hooksOk, new Date());
    const fingerprint = snapshotFingerprint(snap);
    this.latest = snap;
    if (fingerprint === this.lastFingerprint) return;
    this.lastFingerprint = fingerprint;
    this.emit("snapshot", snap);
  }
}

export const attentionService = new AttentionService();
