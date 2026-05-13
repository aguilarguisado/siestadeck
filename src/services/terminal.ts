import { spawn } from "node:child_process";

import { isMac, isWindows } from "./platform.js";

/**
 * Opens a new terminal window running the given shell command. The command
 * lands in a real interactive shell so the user's PATH and history apply
 * (needed for `claude auth login` to round-trip through the browser).
 *
 * macOS: osascript + Terminal.app.
 * Windows: cmd.exe with `start /k` so the window stays open after the
 * command finishes.
 */
export function openTerminalWithCommand(command: string, opts: { cwd?: string } = {}): void {
  if (isMac) {
    const escaped = command.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const cwdPrefix = opts.cwd ? `cd "${opts.cwd.replace(/"/g, '\\"')}" && ` : "";
    const script = `tell application "Terminal" to do script "${cwdPrefix}${escaped}"
tell application "Terminal" to activate`;
    spawn("osascript", ["-e", script], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  if (isWindows) {
    const args = ["/c", "start", "", "cmd.exe", "/k"];
    if (opts.cwd) args.push(`cd /d "${opts.cwd}" && ${command}`);
    else args.push(command);
    spawn("cmd.exe", args, { detached: true, stdio: "ignore" }).unref();
    return;
  }
  // Other platforms not supported; silently no-op so callers don't crash.
}

/**
 * Best-effort native notification. Fire-and-forget.
 *
 * macOS: osascript display-notification (uses the standard Notification Center).
 * Windows: no native toast yet — message lands in the plugin log only.
 */
export function notify(title: string, body: string): void {
  if (isMac) {
    const t = title.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const b = body.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const script = `display notification "${b}" with title "${t}"`;
    spawn("osascript", ["-e", script], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  // Windows / others: no toast in v0.1. The caller's `streamDeck.logger` call
  // (if any) still surfaces the message in the plugin log.
}
