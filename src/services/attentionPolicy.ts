// Pure helpers for the Attention action: hook-event parsing, per-session
// state reduction, TTL expiry, and the ~/.claude/settings.json hook install.
// No I/O, no timers, no SDK refs — fully unit-testable. The service in
// attention.ts wires these into its poll loop.

export const ATTENTION_POLL_MS = 1_000;
export const SETTINGS_CHECK_MS = 10_000;
export const EVENTS_TAIL_BYTES = 64 * 1024;
export const EVENTS_ROTATE_BYTES = 1024 * 1024;
export const ROTATE_GRACE_MS = 2_500;
export const HOOK_STDIN_CAP = 2048;
/** Token present in every installed hook command; its presence per event is the "installed" check. */
export const HOOK_MARKER = "attention.jsonl";
export const BLOCKED_TTL_MS = 2 * 60 * 60_000;
export const SOFT_TTL_MS = 30 * 60_000;

// A session with no terminal attached (killed window, crashed host) never
// sends its clear events; the TTLs above are the zombie-alarm guard.

// notification_type values that mean "a dialog is open and Claude is blocked
// on the user": permission prompts (tool approval, AskUserQuestion, plan
// approval) and MCP elicitation dialogs.
export const BLOCKED_NOTIFICATION_TYPES: ReadonlySet<string> = new Set([
  "permission_prompt",
  "elicitation_dialog",
]);
export const IDLE_NOTIFICATION_TYPES: ReadonlySet<string> = new Set(["idle_prompt"]);

// PreToolUse fires BEFORE the permission dialog (verified empirically), so
// it cannot clear an approved prompt; PostToolUse (tool finished) is the
// earliest post-approval signal and is what un-blocks after the user says yes.
export const HOOK_EVENTS = [
  "Notification",
  "Stop",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "SessionStart",
  "SessionEnd",
] as const;

export type AttentionState = "blocked" | "turn_done" | "idle";

export type RawHookEvent = {
  sessionId: string;
  hookEventName: string;
  notificationType?: string;
  cwd?: string;
};

export type SessionAttention = {
  state: AttentionState;
  /** Epoch ms the session entered this state. */
  since: number;
  cwd: string | null;
  /** `ackKeyFor(this)` when the user acknowledged this exact (state, since). */
  ackKey?: string;
};

export type AttentionSessionView = {
  sessionId: string;
  state: AttentionState;
  since: number;
  cwd: string | null;
  acked: boolean;
};

export type AttentionSnapshot = {
  hooksInstalled: boolean;
  /** Sorted worst-first (severity, then recency). */
  sessions: AttentionSessionView[];
  /** Worst unacknowledged state across all sessions, before per-key toggles. */
  worst: AttentionState | null;
  fetchedAt: Date;
};

export type AttentionKeySettings = {
  alertPermission?: boolean;
  alertTurnDone?: boolean;
  alertIdle?: boolean;
};

export type EnabledStates = Record<AttentionState, boolean>;

const SEVERITY: Record<AttentionState, number> = { blocked: 3, turn_done: 2, idle: 1 };

const SESSION_ID_RE = /"session_id"\s*:\s*"([^"]*)"/;
const EVENT_NAME_RE = /"hook_event_name"\s*:\s*"([^"]*)"/;
const NOTIFICATION_TYPE_RE = /"notification_type"\s*:\s*"([^"]*)"/;
const CWD_RE = /"cwd"\s*:\s*"([^"]*)"/;

/**
 * Parse one appended hook payload line. The hook command caps stdin at
 * HOOK_STDIN_CAP bytes, so lines can be truncated mid-JSON — fall back to
 * regex extraction of the leading fields, which fit well inside the cap.
 */
export function parseAttentionLine(line: string): RawHookEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const d = JSON.parse(trimmed) as Record<string, unknown>;
    if (d && typeof d === "object" && typeof d.session_id === "string" && typeof d.hook_event_name === "string") {
      return {
        sessionId: d.session_id,
        hookEventName: d.hook_event_name,
        notificationType: typeof d.notification_type === "string" ? d.notification_type : undefined,
        cwd: typeof d.cwd === "string" ? d.cwd : undefined,
      };
    }
    return null;
  } catch {
    // truncated — salvage below
  }
  const sessionId = SESSION_ID_RE.exec(trimmed)?.[1];
  const hookEventName = EVENT_NAME_RE.exec(trimmed)?.[1];
  if (!sessionId || !hookEventName) return null;
  return {
    sessionId,
    hookEventName,
    notificationType: NOTIFICATION_TYPE_RE.exec(trimmed)?.[1],
    cwd: CWD_RE.exec(trimmed)?.[1],
  };
}

/**
 * Split a tail-read chunk into complete lines, carrying a trailing partial
 * line (a hook append cut mid-write by the read) over to the next poll.
 */
export function splitCompleteLines(chunk: string, carry: string): { lines: string[]; carry: string } {
  const parts = (carry + chunk).split("\n");
  const nextCarry = parts.pop() ?? "";
  return { lines: parts.filter((l) => l.trim() !== ""), carry: nextCarry };
}

export function ackKeyFor(s: Pick<SessionAttention, "state" | "since">): string {
  return `${s.state}:${s.since}`;
}

function setState(
  map: Map<string, SessionAttention>,
  ev: RawHookEvent,
  state: AttentionState,
  ts: number,
  keepOnRepeat: boolean,
): void {
  const cur = map.get(ev.sessionId);
  const repeat = cur?.state === state;
  map.set(ev.sessionId, {
    state,
    since: repeat && keepOnRepeat ? cur.since : ts,
    cwd: ev.cwd ?? cur?.cwd ?? null,
    ackKey: repeat && keepOnRepeat ? cur.ackKey : undefined,
  });
}

/**
 * Reduce one hook event into the per-session state map.
 *
 * - blocked-type Notification → `blocked`; repeats re-alarm (fresh since, ack dropped)
 * - idle-type Notification → `idle`, but never downgrades `blocked`; it DOES
 *   replace `turn_done` (the same wait escalating: DONE fades to IDLE after
 *   ~60s); idle repeats keep since/ack (the same wait being re-announced)
 * - Stop → `turn_done` (a turn cannot complete while a prompt is pending)
 * - UserPromptSubmit / PreToolUse / PostToolUse / SessionStart / SessionEnd →
 *   clear. PreToolUse fires before the permission dialog, so on approval the
 *   un-block comes from PostToolUse (tool finished) or Stop (turn ended).
 * - everything else (SubagentStop, unknown types) → ignored
 */
export function applyEvent(map: Map<string, SessionAttention>, ev: RawHookEvent, ts: number): void {
  switch (ev.hookEventName) {
    case "Notification": {
      const type = ev.notificationType ?? "";
      if (BLOCKED_NOTIFICATION_TYPES.has(type)) {
        setState(map, ev, "blocked", ts, false);
      } else if (IDLE_NOTIFICATION_TYPES.has(type)) {
        if (map.get(ev.sessionId)?.state === "blocked") return;
        setState(map, ev, "idle", ts, true);
      }
      return;
    }
    case "Stop":
      setState(map, ev, "turn_done", ts, false);
      return;
    case "UserPromptSubmit":
    case "PreToolUse":
    case "PostToolUse":
    case "SessionStart":
    case "SessionEnd":
      map.delete(ev.sessionId);
      return;
    default:
      return;
  }
}

export function expireSessions(map: Map<string, SessionAttention>, now: number): void {
  for (const [id, s] of map) {
    const ttl = s.state === "blocked" ? BLOCKED_TTL_MS : SOFT_TTL_MS;
    if (now - s.since > ttl) map.delete(id);
  }
}

/**
 * Acknowledge every session currently in one of `states`, pinned to its
 * exact (state, since) — any newer event re-alarms. Returns whether
 * anything changed (caller re-emits only then).
 */
export function acknowledgeSessions(
  map: Map<string, SessionAttention>,
  states: readonly AttentionState[],
): boolean {
  let changed = false;
  for (const s of map.values()) {
    if (!states.includes(s.state)) continue;
    const key = ackKeyFor(s);
    if (s.ackKey !== key) {
      s.ackKey = key;
      changed = true;
    }
  }
  return changed;
}

export function toSnapshot(
  map: Map<string, SessionAttention>,
  hooksInstalled: boolean,
  now: Date,
): AttentionSnapshot {
  const sessions: AttentionSessionView[] = Array.from(map.entries())
    .map(([sessionId, s]) => ({
      sessionId,
      state: s.state,
      since: s.since,
      cwd: s.cwd,
      acked: s.ackKey === ackKeyFor(s),
    }))
    .sort(
      (a, b) =>
        SEVERITY[b.state] - SEVERITY[a.state] || b.since - a.since || a.sessionId.localeCompare(b.sessionId),
    );
  let worst: AttentionState | null = null;
  for (const s of sessions) {
    if (s.acked) continue;
    if (!worst || SEVERITY[s.state] > SEVERITY[worst]) worst = s.state;
  }
  return { hooksInstalled, sessions, worst, fetchedAt: now };
}

export function snapshotFingerprint(snap: AttentionSnapshot): string {
  const parts = snap.sessions.map((s) => `${s.sessionId}:${s.state}:${s.since}:${s.acked ? 1 : 0}`);
  return `${snap.hooksInstalled ? 1 : 0}|${parts.join(",")}`;
}

/** Per-key PI toggles; undefined means enabled (checkbox defaults to on). */
export function enabledFromSettings(s: AttentionKeySettings): EnabledStates {
  return {
    blocked: s.alertPermission !== false,
    turn_done: s.alertTurnDone !== false,
    idle: s.alertIdle !== false,
  };
}

/** Sessions this key should alarm on, worst-first (input order is preserved). */
export function alarmingSessions(
  sessions: AttentionSessionView[],
  enabled: EnabledStates,
): AttentionSessionView[] {
  return sessions.filter((s) => !s.acked && enabled[s.state]);
}

// --- hook install ----------------------------------------------------------

export function buildHookCommand(platform: "mac" | "windows"): string {
  if (platform === "windows") {
    // Single quotes only inside -Command so the string survives cmd.exe and
    // JSON serialization; the try/catch retry absorbs file-sharing collisions
    // between concurrent hook processes.
    return (
      `powershell.exe -NoProfile -NonInteractive -Command "` +
      `$d = Join-Path $env:USERPROFILE '.claude\\siestadeck'; ` +
      `[IO.Directory]::CreateDirectory($d) | Out-Null; ` +
      `$t = [Console]::In.ReadToEnd(); ` +
      `if ($t.Length -gt ${HOOK_STDIN_CAP}) { $t = $t.Substring(0, ${HOOK_STDIN_CAP}) }; ` +
      `try { [IO.File]::AppendAllText((Join-Path $d 'attention.jsonl'), $t.TrimEnd() + [char]10) } ` +
      `catch { Start-Sleep -Milliseconds 50; [IO.File]::AppendAllText((Join-Path $d 'attention.jsonl'), $t.TrimEnd() + [char]10) }"`
    );
  }
  // Single printf write keeps the O_APPEND append atomic even with several
  // concurrent Claude Code sessions firing hooks at once. We rely on Claude
  // Code emitting each hook payload as single-line JSON: `head -c` caps the
  // byte count but does not strip interior newlines, so a multi-line payload
  // would land as several lines. The parser tolerates that (each fragment is
  // parsed independently and non-events are dropped), but the one-event-per-
  // line invariant depends on the single-line assumption holding.
  return (
    `mkdir -p "$HOME/.claude/siestadeck" && ` +
    `printf '%s\\n' "$(head -c ${HOOK_STDIN_CAP})" >> "$HOME/.claude/siestadeck/attention.jsonl"`
  );
}

type HookHandler = { type?: unknown; command?: unknown };

function eventHasMarker(entries: unknown): boolean {
  if (!Array.isArray(entries)) return false;
  for (const entry of entries) {
    const list = (entry as { hooks?: unknown } | null)?.hooks;
    if (!Array.isArray(list)) continue;
    for (const h of list as HookHandler[]) {
      if (h?.type === "command" && typeof h.command === "string" && h.command.includes(HOOK_MARKER)) {
        return true;
      }
    }
  }
  return false;
}

/** True iff every HOOK_EVENTS entry carries a command containing HOOK_MARKER. */
export function hooksInstalled(settings: unknown): boolean {
  if (!settings || typeof settings !== "object") return false;
  const hooks = (settings as Record<string, unknown>).hooks;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return false;
  return HOOK_EVENTS.every((event) => eventHasMarker((hooks as Record<string, unknown>)[event]));
}

/**
 * Return a NEW settings object with the attention hooks merged in. Appends
 * an entry only for events still missing the marker (idempotent, completes
 * partial installs) and never touches foreign hook entries or other keys.
 */
export function mergeAttentionHooks(
  settings: Record<string, unknown>,
  platform: "mac" | "windows",
): Record<string, unknown> {
  const command = buildHookCommand(platform);
  const existing =
    settings.hooks && typeof settings.hooks === "object" && !Array.isArray(settings.hooks)
      ? (settings.hooks as Record<string, unknown>)
      : {};
  const hooks: Record<string, unknown> = { ...existing };
  for (const event of HOOK_EVENTS) {
    if (eventHasMarker(hooks[event])) continue;
    const entries = Array.isArray(hooks[event]) ? [...(hooks[event] as unknown[])] : [];
    entries.push({ hooks: [{ type: "command", command }] });
    hooks[event] = entries;
  }
  return { ...settings, hooks };
}

/**
 * Strip every attention hook handler (command contains HOOK_MARKER) from one
 * event's entry, returning a NEW entry — or null when the entry held nothing
 * but ours and should be dropped entirely. Foreign-shaped or marker-free
 * entries are returned unchanged (same reference; never mutated).
 */
function stripMarkerHandlers(entry: unknown): unknown | null {
  const obj = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : null;
  const list = obj?.hooks;
  if (!Array.isArray(list)) return entry; // foreign shape — leave untouched
  const kept = (list as HookHandler[]).filter(
    (h) => !(h?.type === "command" && typeof h.command === "string" && h.command.includes(HOOK_MARKER)),
  );
  if (kept.length === list.length) return entry; // nothing of ours in here
  if (kept.length === 0) return null; // was ours only — drop the whole entry
  return { ...obj, hooks: kept };
}

/**
 * Return a NEW settings object with the attention hooks removed — the inverse
 * of mergeAttentionHooks. Strips only handlers whose command carries
 * HOOK_MARKER, drops entries left empty, removes an event key once it has no
 * entries, and deletes the top-level `hooks` key if it ends up empty. Foreign
 * hooks and every other setting are preserved untouched. Idempotent, and never
 * mutates its input.
 */
export function removeAttentionHooks(settings: Record<string, unknown>): Record<string, unknown> {
  const hooks =
    settings.hooks && typeof settings.hooks === "object" && !Array.isArray(settings.hooks)
      ? (settings.hooks as Record<string, unknown>)
      : null;
  if (!hooks) return { ...settings };
  const nextHooks: Record<string, unknown> = {};
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) {
      nextHooks[event] = entries; // non-array event value — leave as-is
      continue;
    }
    const kept = entries.map(stripMarkerHandlers).filter((e) => e !== null);
    if (kept.length > 0) nextHooks[event] = kept;
  }
  const next: Record<string, unknown> = { ...settings };
  if (Object.keys(nextHooks).length > 0) next.hooks = nextHooks;
  else delete next.hooks;
  return next;
}
