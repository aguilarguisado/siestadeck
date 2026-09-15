import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { isMac, isWindows } from "./platform.js";
import { winCredsDir } from "./paths.js";

export interface CredentialStore {
  read(service: string, account?: string): Promise<string>;
  write(service: string, account: string, password: string): Promise<void>;
}

type SpawnResult = { code: number; stdout: string; stderr: string };

function runCapture(
  cmd: string,
  args: string[],
  opts: { input?: string; timeoutMs?: number } = {},
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          proc.kill();
          reject(new Error(`${cmd} timed out after ${opts.timeoutMs}ms`));
        }, opts.timeoutMs)
      : null;
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    proc.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    if (opts.input !== undefined) {
      proc.stdin.write(opts.input);
      proc.stdin.end();
    }
  });
}

// ----- macOS Keychain via security(1) -----

export const macStore: CredentialStore = {
  async read(service: string, account?: string): Promise<string> {
    const args = account
      ? ["find-generic-password", "-a", account, "-s", service, "-w"]
      : ["find-generic-password", "-s", service, "-w"];
    const { code, stdout, stderr } = await runCapture("security", args);
    if (code !== 0) throw new Error(`security exited ${code}: ${stderr.trim()}`);
    return stdout.trim();
  },
  async write(service: string, account: string, password: string): Promise<void> {
    const { code, stderr } = await runCapture("security", [
      "add-generic-password",
      "-U",
      "-s", service,
      "-a", account,
      "-w", password,
    ]);
    if (code !== 0) throw new Error(`security exited ${code}: ${stderr.trim()}`);
  },
};

// ----- Windows DPAPI via PowerShell shell-out -----
//
// Each credential is encrypted with [System.Security.Cryptography.ProtectedData]
// under CurrentUser scope and persisted as a single file under
// %APPDATA%\siestadeck\creds\<key>.bin. No native module required.
//
// PowerShell spawn cost (~150-300ms each) is amortized by a per-process cache
// stamped with the backing file's identity.
//
// Validating that cache against the file is what makes it safe to share a
// machine with a second siesta app. Caching by key alone was a per-process
// cache of a file another process rewrites: app A hits a 401, redeems the
// single-use refresh_token and writes a new stash; app B keeps returning the
// old blob forever, redeems an already-spent refresh token, earns a 400 and
// parks itself in a 30-minute auth backoff pinned to that dead token. The user
// logs in again, B re-reads its own cache, sees the same dead token,
// `shouldClearAuthBackoff` stays false, and the LOG IN tile never clears. One
// fs.readFile per read buys that back; the expensive part was always the
// PowerShell spawn, which reading the bytes still avoids.

const PS_TIMEOUT_MS = 5_000;

type DpapiEntry = { hash: string; plain: string };
const dpapiCache = new Map<string, DpapiEntry>();

/**
 * Identity of a blob, taken from the bytes themselves.
 *
 * An mtime+size stamp is cheaper to obtain but cannot be taken safely on the
 * write path: between our `writeFile` and a `stat` of what we wrote, a second
 * app can replace the file, and we would cache *our* plaintext under *their*
 * stamp — an entry that matches on every subsequent read and therefore never
 * re-decrypts. That is the stale-credential failure above, reintroduced by the
 * very code meant to prevent it. Hashing the ciphertext we already hold has no
 * such window: the identity comes from the bytes, not from a second filesystem
 * observation that can race with another writer.
 */
function hashOf(cipher: Buffer): string {
  return createHash("sha1").update(cipher).digest("hex");
}

function credKey(service: string, account?: string): string {
  const composite = account ? `${service}__${account}` : service;
  return createHash("sha1").update(composite).digest("hex");
}

function credPath(service: string, account?: string): string {
  return path.join(winCredsDir, `${credKey(service, account)}.bin`);
}

async function dpapiProtect(plaintext: string): Promise<Buffer> {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Security",
    "$stdin = [Console]::In.ReadToEnd()",
    "$bytes = [System.Text.Encoding]::UTF8.GetBytes($stdin)",
    "$enc = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, 'CurrentUser')",
    "[Console]::OpenStandardOutput().Write($enc, 0, $enc.Length)",
  ].join("; ");
  const proc = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`powershell Protect timed out after ${PS_TIMEOUT_MS}ms`));
    }, PS_TIMEOUT_MS);
    proc.stdout.on("data", (d: Buffer) => chunks.push(d));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`powershell Protect exited ${code}: ${stderr.trim()}`));
      else resolve(Buffer.concat(chunks));
    });
    proc.stdin.write(plaintext);
    proc.stdin.end();
  });
}

async function dpapiUnprotect(cipher: Buffer): Promise<string> {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Security",
    "$in = [Console]::OpenStandardInput()",
    "$ms = New-Object System.IO.MemoryStream",
    "$in.CopyTo($ms)",
    "$bytes = $ms.ToArray()",
    "$plain = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, 'CurrentUser')",
    "[Console]::Out.Write([System.Text.Encoding]::UTF8.GetString($plain))",
  ].join("; ");
  const proc = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`powershell Unprotect timed out after ${PS_TIMEOUT_MS}ms`));
    }, PS_TIMEOUT_MS);
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`powershell Unprotect exited ${code}: ${stderr.trim()}`));
      else resolve(stdout);
    });
    proc.stdin.write(cipher);
    proc.stdin.end();
  });
}

export const winStore: CredentialStore = {
  async read(service: string, account?: string): Promise<string> {
    const key = credKey(service, account);
    const file = credPath(service, account);
    let cipher: Buffer;
    try {
      cipher = await fs.readFile(file);
    } catch (err) {
      // No file (or unreadable): drop any entry rather than leave a blob that
      // outlives the credential it came from, and surface the error exactly as
      // the bare readFile used to.
      dpapiCache.delete(key);
      throw err;
    }
    // Hashed from the bytes we are about to decrypt, so the entry describes
    // exactly the blob it came from no matter who wrote the file when.
    const hash = hashOf(cipher);
    const cached = dpapiCache.get(key);
    if (cached?.hash === hash) return cached.plain;
    const plain = await dpapiUnprotect(cipher);
    dpapiCache.set(key, { hash, plain });
    return plain;
  },
  async write(service: string, account: string, password: string): Promise<void> {
    const cipher = await dpapiProtect(password);
    await fs.mkdir(winCredsDir, { recursive: true });
    const file = credPath(service, account);
    await fs.writeFile(file, cipher);
    // Keyed on the ciphertext we just wrote, so this process keeps its own
    // amortization rather than paying a spawn to re-learn its own secret.
    // Deliberately not a stat of the file: see hashOf. If another app
    // overwrites the blob after this, its bytes hash differently and the next
    // read re-decrypts.
    dpapiCache.set(credKey(service, account), { hash: hashOf(cipher), plain: password });
  },
};

export const noopStore: CredentialStore = {
  async read(): Promise<string> {
    throw new Error(`Credential store not implemented for platform ${process.platform}`);
  },
  async write(): Promise<void> {
    throw new Error(`Credential store not implemented for platform ${process.platform}`);
  },
};

export const credentialStore: CredentialStore = isMac ? macStore : isWindows ? winStore : noopStore;
