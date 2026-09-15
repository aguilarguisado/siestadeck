/**
 * `@siesta/core` — the UI-agnostic half of siesta.
 *
 * Everything a host needs to read Claude Code quota, manage the account
 * registry, and follow the live session. Nothing in here knows about Stream
 * Deck keys, tray icons, SVG, or rendering of any kind.
 *
 * **Membership rule.** A symbol is public only if a host calls it, or if it
 * names a type appearing in the signature of something a host calls. Everything
 * else is an implementation detail: `package.json`'s `exports` map has a single
 * `"."` entry, so "absent from this file" means "not reachable".
 *
 * Deliberately internal — listed so the omissions read as decisions rather than
 * oversights: `keychain.ts`, `credentialStore.ts`, `oauthRefresh.ts` (credential
 * handling is `accountsService`'s job and nothing outside should reach past it),
 * `idle.ts`, `log()` itself, and every policy helper except `pickNextSlug`.
 *
 * **Hosts are separate processes, not separate instances.** Each gets its own
 * module registry and therefore its own singletons, which is why this file
 * exports singletons rather than factories. The classes come along so consumers
 * can name the type; note `QuotaRegistry` binds the module-level
 * `accountsService`, so a second instance would not be independent.
 */

// ── host seam ───────────────────────────────────────────────────────────────
// Bind once at startup, before accountsService.start(). Anything logged before
// that is silently dropped — the default sink is a no-op, not console.
export { setLogger, resetLogger, type Logger } from "./log.js";

// ── services ────────────────────────────────────────────────────────────────
export { accountsService, AccountsService, type Account } from "./accounts.js";
export { quotaRegistry, QuotaRegistry } from "./quota.js";
export {
  activeSessionService,
  ActiveSessionService,
  type ActiveSessionSnapshot,
} from "./activeSession.js";

// ── snapshot shapes ─────────────────────────────────────────────────────────
// BackoffReason is load-bearing, not incidental: a host that renders "WAIT" vs
// "LOG IN" has to switch on it.
export type {
  QuotaSnapshot,
  QuotaWindowSnapshot,
  BackoffReason,
} from "./quotaPolicy.js";

// ── tunables a host UI must agree with ──────────────────────────────────────
// The one knob a host surfaces to the user. `enableAutoRefresh` clamps to this
// internally; exporting it stops each host hardcoding "5 minutes" in its form.
export { MIN_AUTO_POLL_MS } from "./quotaPolicy.js";

// ── account cycle order ─────────────────────────────────────────────────────
// Callers pass `Account[]`, which structurally satisfies the `Orderable[]`
// parameter, so the ordering contract itself stays private.
export { pickNextSlug } from "./accountsPolicy.js";

// ── platform + owned files ──────────────────────────────────────────────────
export { isMac, isWindows } from "./platform.js";
export { claudeSettingsJson } from "./paths.js";

// ── host-side shell utilities ───────────────────────────────────────────────
// Plain cross-platform Node helpers a host may use or ignore. No core service
// calls either of these — a data service has no business grabbing the user's
// attention, so the decision of whether to notify lives in the host.
export { openTerminalWithCommand, notify } from "./terminal.js";
