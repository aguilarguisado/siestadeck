import { describe, expect, it } from "vitest";

import {
  acknowledgeSessions,
  alarmingSessions,
  applyEvent,
  BLOCKED_TTL_MS,
  buildHookCommand,
  enabledFromSettings,
  expireSessions,
  HOOK_EVENTS,
  HOOK_MARKER,
  HOOK_STDIN_CAP,
  hooksInstalled,
  mergeAttentionHooks,
  parseAttentionLine,
  type RawHookEvent,
  removeAttentionHooks,
  type SessionAttention,
  snapshotFingerprint,
  SOFT_TTL_MS,
  splitCompleteLines,
  toSnapshot,
} from "./attentionPolicy.js";

const NOW = 1_700_000_000_000;

function ev(overrides: Partial<RawHookEvent> & { hookEventName: string }): RawHookEvent {
  return { sessionId: "s1", cwd: "/Users/juan/Projects/lab/siesta", ...overrides };
}

function notif(type: string, sessionId = "s1"): RawHookEvent {
  return ev({ hookEventName: "Notification", notificationType: type, sessionId });
}

describe("parseAttentionLine", () => {
  it("parses a full hook payload", () => {
    const line = JSON.stringify({
      session_id: "abc123",
      prompt_id: "p_1",
      transcript_path: "/Users/juan/.claude/projects/x/abc123.jsonl",
      cwd: "/Users/juan/Projects/lab/siesta",
      hook_event_name: "Notification",
      permission_mode: "default",
      notification_type: "permission_prompt",
    });
    expect(parseAttentionLine(line)).toEqual({
      sessionId: "abc123",
      hookEventName: "Notification",
      notificationType: "permission_prompt",
      cwd: "/Users/juan/Projects/lab/siesta",
    });
  });

  it("omits optional fields that are absent", () => {
    const line = JSON.stringify({ session_id: "abc", hook_event_name: "Stop", turn_number: 3 });
    expect(parseAttentionLine(line)).toEqual({
      sessionId: "abc",
      hookEventName: "Stop",
      notificationType: undefined,
      cwd: undefined,
    });
  });

  it("salvages a line truncated by the stdin cap via regex fallback", () => {
    const full = JSON.stringify({
      session_id: "abc123",
      hook_event_name: "PreToolUse",
      cwd: "/Users/juan/Projects/lab/siesta",
      tool_name: "Write",
      tool_input: { content: "x".repeat(5000) },
    });
    const truncated = full.slice(0, HOOK_STDIN_CAP);
    expect(() => JSON.parse(truncated)).toThrow(); // precondition: really truncated
    expect(parseAttentionLine(truncated)).toEqual({
      sessionId: "abc123",
      hookEventName: "PreToolUse",
      notificationType: undefined,
      cwd: "/Users/juan/Projects/lab/siesta",
    });
  });

  it("returns null for garbage, blank lines, and JSON without the required fields", () => {
    expect(parseAttentionLine("")).toBeNull();
    expect(parseAttentionLine("   ")).toBeNull();
    expect(parseAttentionLine("not json at all")).toBeNull();
    expect(parseAttentionLine("{}")).toBeNull();
    expect(parseAttentionLine(JSON.stringify({ session_id: "x" }))).toBeNull();
    expect(parseAttentionLine(JSON.stringify({ hook_event_name: "Stop" }))).toBeNull();
    expect(parseAttentionLine(JSON.stringify([1, 2, 3]))).toBeNull();
  });
});

describe("splitCompleteLines", () => {
  it("returns complete lines and carries the trailing partial", () => {
    const { lines, carry } = splitCompleteLines('{"a":1}\n{"b":2}\n{"c":', "");
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
    expect(carry).toBe('{"c":');
  });

  it("prepends the previous carry to the next chunk", () => {
    const first = splitCompleteLines('{"a"', "");
    const second = splitCompleteLines(':1}\n', first.carry);
    expect(second.lines).toEqual(['{"a":1}']);
    expect(second.carry).toBe("");
  });

  it("drops blank lines and handles empty input", () => {
    expect(splitCompleteLines("\n\n \n", "").lines).toEqual([]);
    expect(splitCompleteLines("", "").carry).toBe("");
  });
});

describe("applyEvent", () => {
  it("permission_prompt sets blocked", () => {
    const map = new Map<string, SessionAttention>();
    applyEvent(map, notif("permission_prompt"), NOW);
    expect(map.get("s1")).toMatchObject({ state: "blocked", since: NOW, cwd: "/Users/juan/Projects/lab/siesta" });
  });

  it("elicitation_dialog sets blocked", () => {
    const map = new Map<string, SessionAttention>();
    applyEvent(map, notif("elicitation_dialog"), NOW);
    expect(map.get("s1")?.state).toBe("blocked");
  });

  it("idle_prompt sets idle but never downgrades blocked", () => {
    const map = new Map<string, SessionAttention>();
    applyEvent(map, notif("idle_prompt"), NOW);
    expect(map.get("s1")?.state).toBe("idle");
    applyEvent(map, notif("permission_prompt"), NOW + 1);
    applyEvent(map, notif("idle_prompt"), NOW + 2);
    expect(map.get("s1")).toMatchObject({ state: "blocked", since: NOW + 1 });
  });

  it("other notification types are ignored", () => {
    const map = new Map<string, SessionAttention>();
    applyEvent(map, notif("auth_success"), NOW);
    applyEvent(map, notif("elicitation_complete"), NOW);
    applyEvent(map, ev({ hookEventName: "Notification" }), NOW); // no type at all
    expect(map.size).toBe(0);
  });

  it("Stop sets turn_done and overwrites blocked", () => {
    const map = new Map<string, SessionAttention>();
    applyEvent(map, notif("permission_prompt"), NOW);
    applyEvent(map, ev({ hookEventName: "Stop" }), NOW + 5);
    expect(map.get("s1")).toMatchObject({ state: "turn_done", since: NOW + 5 });
  });

  it.each(["UserPromptSubmit", "PreToolUse", "PostToolUse", "SessionStart", "SessionEnd"])(
    "%s clears the session",
    (name) => {
      const map = new Map<string, SessionAttention>();
      applyEvent(map, notif("permission_prompt"), NOW);
      applyEvent(map, ev({ hookEventName: name }), NOW + 1);
      expect(map.size).toBe(0);
    },
  );

  it("unknown event names (SubagentStop) leave state untouched", () => {
    const map = new Map<string, SessionAttention>();
    applyEvent(map, notif("permission_prompt"), NOW);
    applyEvent(map, ev({ hookEventName: "SubagentStop" }), NOW + 1);
    expect(map.get("s1")).toMatchObject({ state: "blocked", since: NOW });
  });

  it("idle_prompt replaces turn_done (DONE escalates to IDLE after ~60s)", () => {
    const map = new Map<string, SessionAttention>();
    applyEvent(map, ev({ hookEventName: "Stop" }), NOW);
    applyEvent(map, notif("idle_prompt"), NOW + 60_000);
    expect(map.get("s1")).toMatchObject({ state: "idle", since: NOW + 60_000 });
  });

  it("repeated idle keeps since and ack (same wait re-announced)", () => {
    const map = new Map<string, SessionAttention>();
    applyEvent(map, notif("idle_prompt"), NOW);
    acknowledgeSessions(map, ["idle"]);
    applyEvent(map, notif("idle_prompt"), NOW + 60_000);
    expect(map.get("s1")).toMatchObject({ state: "idle", since: NOW });
    expect(toSnapshot(map, true, new Date(NOW + 60_000)).sessions[0]!.acked).toBe(true);
  });

  it("repeated blocked re-alarms (fresh since, ack dropped)", () => {
    const map = new Map<string, SessionAttention>();
    applyEvent(map, notif("permission_prompt"), NOW);
    acknowledgeSessions(map, ["blocked"]);
    applyEvent(map, notif("permission_prompt"), NOW + 1_000);
    expect(map.get("s1")).toMatchObject({ state: "blocked", since: NOW + 1_000 });
    expect(toSnapshot(map, true, new Date(NOW + 1_000)).sessions[0]!.acked).toBe(false);
  });

  it("keeps the last known cwd when a later event lacks one", () => {
    const map = new Map<string, SessionAttention>();
    applyEvent(map, notif("idle_prompt"), NOW);
    applyEvent(map, { sessionId: "s1", hookEventName: "Stop" }, NOW + 1);
    expect(map.get("s1")?.cwd).toBe("/Users/juan/Projects/lab/siesta");
  });

  it("tracks sessions independently", () => {
    const map = new Map<string, SessionAttention>();
    applyEvent(map, notif("permission_prompt", "a"), NOW);
    applyEvent(map, notif("idle_prompt", "b"), NOW);
    applyEvent(map, ev({ hookEventName: "SessionEnd", sessionId: "a" }), NOW + 1);
    expect(map.has("a")).toBe(false);
    expect(map.get("b")?.state).toBe("idle");
  });
});

describe("expireSessions", () => {
  it("expires blocked after BLOCKED_TTL_MS and soft states after SOFT_TTL_MS", () => {
    const map = new Map<string, SessionAttention>();
    applyEvent(map, notif("permission_prompt", "b"), NOW);
    applyEvent(map, notif("idle_prompt", "i"), NOW);
    applyEvent(map, ev({ hookEventName: "Stop", sessionId: "t" }), NOW);

    expireSessions(map, NOW + SOFT_TTL_MS); // exactly at the boundary: kept
    expect(map.size).toBe(3);

    expireSessions(map, NOW + SOFT_TTL_MS + 1);
    expect([...map.keys()]).toEqual(["b"]);

    expireSessions(map, NOW + BLOCKED_TTL_MS + 1);
    expect(map.size).toBe(0);
  });
});

describe("acknowledgeSessions", () => {
  it("acks only the listed states and reports whether anything changed", () => {
    const map = new Map<string, SessionAttention>();
    applyEvent(map, notif("permission_prompt", "b"), NOW);
    applyEvent(map, notif("idle_prompt", "i"), NOW);
    expect(acknowledgeSessions(map, ["blocked"])).toBe(true);
    expect(acknowledgeSessions(map, ["blocked"])).toBe(false); // already acked
    const snap = toSnapshot(map, true, new Date(NOW));
    expect(snap.sessions.find((s) => s.sessionId === "b")?.acked).toBe(true);
    expect(snap.sessions.find((s) => s.sessionId === "i")?.acked).toBe(false);
  });
});

describe("toSnapshot", () => {
  it("sorts by severity then recency and computes worst over unacked sessions", () => {
    const map = new Map<string, SessionAttention>();
    applyEvent(map, notif("idle_prompt", "i"), NOW + 10);
    applyEvent(map, ev({ hookEventName: "Stop", sessionId: "t1" }), NOW + 1);
    applyEvent(map, ev({ hookEventName: "Stop", sessionId: "t2" }), NOW + 2);
    applyEvent(map, notif("permission_prompt", "b"), NOW);
    const snap = toSnapshot(map, true, new Date(NOW + 11));
    expect(snap.sessions.map((s) => s.sessionId)).toEqual(["b", "t2", "t1", "i"]);
    expect(snap.worst).toBe("blocked");
  });

  it("acked sessions do not contribute to worst", () => {
    const map = new Map<string, SessionAttention>();
    applyEvent(map, notif("permission_prompt", "b"), NOW);
    applyEvent(map, ev({ hookEventName: "Stop", sessionId: "t" }), NOW);
    acknowledgeSessions(map, ["blocked"]);
    expect(toSnapshot(map, true, new Date(NOW)).worst).toBe("turn_done");
    acknowledgeSessions(map, ["turn_done"]);
    expect(toSnapshot(map, true, new Date(NOW)).worst).toBeNull();
  });

  it("empty map yields empty sessions and null worst", () => {
    const snap = toSnapshot(new Map(), false, new Date(NOW));
    expect(snap).toMatchObject({ hooksInstalled: false, sessions: [], worst: null });
  });
});

describe("snapshotFingerprint", () => {
  it("is stable for identical state and differs when state, ack, or install changes", () => {
    const map = new Map<string, SessionAttention>();
    applyEvent(map, notif("permission_prompt"), NOW);
    const a = snapshotFingerprint(toSnapshot(map, true, new Date(NOW)));
    const b = snapshotFingerprint(toSnapshot(map, true, new Date(NOW + 999))); // fetchedAt ignored
    expect(a).toBe(b);
    acknowledgeSessions(map, ["blocked"]);
    expect(snapshotFingerprint(toSnapshot(map, true, new Date(NOW)))).not.toBe(a);
    expect(snapshotFingerprint(toSnapshot(map, false, new Date(NOW)))).not.toBe(a);
  });
});

describe("enabledFromSettings / alarmingSessions", () => {
  it("defaults every toggle to on; explicit false disables", () => {
    expect(enabledFromSettings({})).toEqual({ blocked: true, turn_done: true, idle: true });
    expect(enabledFromSettings({ alertTurnDone: false })).toEqual({
      blocked: true,
      turn_done: false,
      idle: true,
    });
  });

  it("filters acked sessions and disabled states, preserving order", () => {
    const map = new Map<string, SessionAttention>();
    applyEvent(map, notif("permission_prompt", "b"), NOW);
    applyEvent(map, ev({ hookEventName: "Stop", sessionId: "t" }), NOW);
    applyEvent(map, notif("idle_prompt", "i"), NOW);
    acknowledgeSessions(map, ["idle"]);
    const snap = toSnapshot(map, true, new Date(NOW));
    const alarming = alarmingSessions(snap.sessions, enabledFromSettings({ alertTurnDone: false }));
    expect(alarming.map((s) => s.sessionId)).toEqual(["b"]);
  });
});

describe("hook install", () => {
  it("both platform commands contain the marker and the stdin cap", () => {
    for (const platform of ["mac", "windows"] as const) {
      const cmd = buildHookCommand(platform);
      expect(cmd).toContain(HOOK_MARKER);
      expect(cmd).toContain(String(HOOK_STDIN_CAP));
    }
    expect(buildHookCommand("mac")).toContain("head -c");
    expect(buildHookCommand("windows")).toContain("powershell.exe");
    // the -Command payload must stick to single quotes: exactly one pair of
    // double quotes (the wrapper) in the whole command string
    expect(buildHookCommand("windows").split('"')).toHaveLength(3);
  });

  it("hooksInstalled requires the marker on every hook event", () => {
    expect(hooksInstalled(null)).toBe(false);
    expect(hooksInstalled(undefined)).toBe(false);
    expect(hooksInstalled("nope")).toBe(false);
    expect(hooksInstalled({})).toBe(false);
    expect(hooksInstalled({ hooks: [] })).toBe(false);

    const full = mergeAttentionHooks({}, "mac");
    expect(hooksInstalled(full)).toBe(true);

    const partial = mergeAttentionHooks({}, "mac") as { hooks: Record<string, unknown> };
    delete partial.hooks.SessionEnd;
    expect(hooksInstalled(partial)).toBe(false);
  });

  it("foreign hooks without the marker do not count as installed", () => {
    const settings = {
      hooks: Object.fromEntries(
        HOOK_EVENTS.map((e) => [
          e,
          [{ hooks: [{ type: "command", command: "notify-send hi" }] }],
        ]),
      ),
    };
    expect(hooksInstalled(settings)).toBe(false);
    // a matching command under a non-command type doesn't count either
    const wrongType = {
      hooks: Object.fromEntries(
        HOOK_EVENTS.map((e) => [e, [{ hooks: [{ type: "http", command: `x ${HOOK_MARKER}` }] }]]),
      ),
    };
    expect(hooksInstalled(wrongType)).toBe(false);
  });

  it("mergeAttentionHooks installs all six events into empty settings", () => {
    const merged = mergeAttentionHooks({}, "mac");
    expect(hooksInstalled(merged)).toBe(true);
    const hooks = merged.hooks as Record<string, unknown[]>;
    expect(Object.keys(hooks).sort()).toEqual([...HOOK_EVENTS].sort());
    for (const e of HOOK_EVENTS) expect(hooks[e]).toHaveLength(1);
  });

  it("is idempotent and completes partial installs", () => {
    const once = mergeAttentionHooks({}, "mac");
    const twice = mergeAttentionHooks(once, "mac");
    expect(twice).toEqual(once);

    const partial = mergeAttentionHooks({}, "mac") as { hooks: Record<string, unknown> };
    delete partial.hooks.Stop;
    const completed = mergeAttentionHooks(partial as Record<string, unknown>, "mac");
    expect(hooksInstalled(completed)).toBe(true);
  });

  it("removeAttentionHooks fully reverses mergeAttentionHooks into empty settings", () => {
    const merged = mergeAttentionHooks({}, "mac");
    expect(hooksInstalled(merged)).toBe(true);
    const removed = removeAttentionHooks(merged);
    expect(removed).toEqual({}); // hooks key dropped entirely once empty
    expect(hooksInstalled(removed)).toBe(false);
  });

  it("removeAttentionHooks is idempotent and a no-op on hook-free settings", () => {
    expect(removeAttentionHooks({})).toEqual({});
    expect(removeAttentionHooks({ model: "opus" })).toEqual({ model: "opus" });
    expect(removeAttentionHooks({ hooks: "nope" })).toEqual({ hooks: "nope" }); // non-object hooks untouched
    // a non-array event value is passed through untouched
    expect(removeAttentionHooks({ hooks: { Notification: "weird" } })).toEqual({
      hooks: { Notification: "weird" },
    });
    const once = removeAttentionHooks(mergeAttentionHooks({}, "mac"));
    expect(removeAttentionHooks(once)).toEqual(once);
  });

  it("removeAttentionHooks strips only marker entries, keeping foreign ones and other keys, without mutating input", () => {
    const foreign = { hooks: [{ type: "command", command: "afplay /System/Library/Sounds/Ping.aiff" }] };
    const base: Record<string, unknown> = {
      model: "opus",
      env: { FOO: "bar" },
      hooks: { Notification: [foreign], SubagentStop: [foreign] },
    };
    const merged = mergeAttentionHooks(base, "mac");
    expect(hooksInstalled(merged)).toBe(true);
    const before = JSON.parse(JSON.stringify(merged));
    const removed = removeAttentionHooks(merged) as {
      model: string;
      env: unknown;
      hooks: Record<string, unknown[]>;
    };
    expect(merged).toEqual(before); // input untouched
    expect(hooksInstalled(removed)).toBe(false);
    expect(removed.model).toBe("opus");
    expect(removed.env).toEqual({ FOO: "bar" });
    expect(removed.hooks.Notification).toEqual([foreign]); // foreign entry kept
    expect(removed.hooks.SubagentStop).toEqual([foreign]); // never-installed event kept
    expect(removed.hooks.Stop).toBeUndefined(); // ours-only event dropped
    expect(removeAttentionHooks(merged)).toEqual(base); // round-trips to the original shape
  });

  it("removeAttentionHooks leaves entries without a hooks array untouched", () => {
    const settings = { hooks: { Stop: [{ matcher: "*" }, "weird"] } };
    const removed = removeAttentionHooks(settings) as { hooks: Record<string, unknown[]> };
    expect(removed.hooks.Stop).toEqual([{ matcher: "*" }, "weird"]);
  });

  it("removeAttentionHooks drops the marker handler but keeps a foreign sibling in the same entry", () => {
    const foreignHandler = { type: "command", command: "notify-send hi" };
    const markerHandler = { type: "command", command: buildHookCommand("mac") };
    const settings = { hooks: { Stop: [{ hooks: [foreignHandler, markerHandler] }] } };
    const removed = removeAttentionHooks(settings) as { hooks: Record<string, unknown[]> };
    expect(removed.hooks.Stop).toEqual([{ hooks: [foreignHandler] }]);
  });

  it("preserves foreign hook entries and unrelated top-level keys, without mutating input", () => {
    const foreign = { hooks: [{ type: "command", command: "afplay /System/Library/Sounds/Ping.aiff" }] };
    const settings: Record<string, unknown> = {
      model: "opus",
      env: { FOO: "bar" },
      hooks: { Notification: [foreign], SubagentStop: [foreign] },
    };
    const before = JSON.parse(JSON.stringify(settings));
    const merged = mergeAttentionHooks(settings, "mac");
    expect(settings).toEqual(before); // input untouched
    expect(merged.model).toBe("opus");
    expect(merged.env).toEqual({ FOO: "bar" });
    const hooks = merged.hooks as Record<string, unknown[]>;
    expect(hooks.Notification![0]).toEqual(foreign); // foreign entry first, untouched
    expect(hooks.Notification).toHaveLength(2);
    expect(hooks.SubagentStop).toEqual([foreign]); // non-attention event untouched
    expect(hooksInstalled(merged)).toBe(true);
  });
});
