import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface ClaudeAuthStatus {
  loggedIn: boolean;
  email: string | null;
  organization: string | null;
  subscriptionType: string | null;
}

export type ClaudeLoginEvent =
  | { type: "status"; stage: "starting" }
  | { type: "url"; url: string }
  | { type: "success" }
  | { type: "error"; message: string; fallback: boolean };

// The Claude Agent SDK ships the actual `claude` CLI binary as a
// platform-specific optional dependency (this app already depends on the
// SDK itself, so this is normally always resolvable) — using that exact
// binary keeps `claude auth login`/`status` consistent with whatever
// version the SDK's own query() calls are running. Falls back to a bare
// "claude" on PATH (a separately-installed global CLI) if the platform
// package can't be found, e.g. on an unlisted platform/arch.
//
// Deliberately NOT require.resolve() — under Next.js/Turbopack's dev
// bundler, require.resolve() for another package returns a virtualized
// "[project]/node_modules/..." module-graph identifier, not a real
// filesystem path (confirmed directly: it doesn't fs.existsSync at all).
// import.meta.url for *this own file* is the one thing that stays a real
// file:// path, so walk up from there — the same directory-by-directory
// node_modules search Node's own CommonJS resolution does — until the
// platform package turns up. Works regardless of whether node_modules is
// hoisted to the workspace root or nested under apps/web.
function resolveClaudeCliPath(): string {
  const { platform, arch } = process;
  const suffix =
    platform === "darwin" && arch === "arm64"
      ? "darwin-arm64"
      : platform === "darwin" && arch === "x64"
        ? "darwin-x64"
        : platform === "linux" && arch === "arm64"
          ? "linux-arm64"
          : platform === "linux" && arch === "x64"
            ? "linux-x64"
            : platform === "win32" && arch === "arm64"
              ? "win32-arm64"
              : platform === "win32" && arch === "x64"
                ? "win32-x64"
                : null;

  if (suffix) {
    const binName = platform === "win32" ? "claude.exe" : "claude";
    let dir = path.dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 12; i++) {
      const candidate = path.join(
        dir,
        "node_modules",
        "@anthropic-ai",
        `claude-agent-sdk-${suffix}`,
        binName,
      );
      if (fs.existsSync(candidate)) return candidate;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return "claude";
}

const STATUS_TIMEOUT_MS = 10_000;

/**
 * Runs `claude auth status --json` — a read-only, non-mutating check, safe
 * to call as often as needed (unlike login/logout). Never throws: a missing
 * CLI, a parse failure, or a non-zero exit (which `claude auth status`
 * itself uses to signal "not logged in") all resolve to `loggedIn: false`.
 */
export function getClaudeAuthStatus(): Promise<ClaudeAuthStatus> {
  return new Promise((resolve) => {
    const child = spawn(resolveClaudeCliPath(), ["auth", "status", "--json"], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: STATUS_TIMEOUT_MS,
    });

    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.on("error", () => {
      resolve({
        loggedIn: false,
        email: null,
        organization: null,
        subscriptionType: null,
      });
    });
    child.on("close", () => {
      try {
        const parsed = JSON.parse(stdout);
        resolve({
          loggedIn: Boolean(parsed.loggedIn),
          email: parsed.email ?? null,
          organization: parsed.orgName ?? null,
          subscriptionType: parsed.subscriptionType ?? null,
        });
      } catch {
        resolve({
          loggedIn: false,
          email: null,
          organization: null,
          subscriptionType: null,
        });
      }
    });
  });
}

export async function runClaudeLogout(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(resolveClaudeCliPath(), ["auth", "logout"], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: STATUS_TIMEOUT_MS,
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || "claude auth logout failed"));
    });
  });
}

interface LoginSession {
  child: ChildProcessWithoutNullStreams;
  push: (event: ClaudeLoginEvent) => void;
}

// Keyed by loginId so the code the user pastes back (submitted on a
// separate request — see submitClaudeLoginCode) can reach the same
// in-flight child process that the SSE route is still streaming from.
// Same "session map keyed by a caller-visible id" shape as
// lib/ai/agent.ts's liveSessions, for the same reason: one HTTP request
// starts the process, a later one needs to reach back into it.
const sessions = new Map<string, LoginSession>();

const URL_PATTERN =
  /(https:\/\/\S*(?:claude\.(?:ai|com)|console\.anthropic\.com)\S*)/;
const URL_TIMEOUT_MS = 20_000;
const OVERALL_TIMEOUT_MS = 5 * 60_000;

/**
 * Drives `claude auth login`. Unlike GitHub's device-code flow (which needs
 * no further input once the browser tab is open), Claude's flow shows the
 * user a code on the post-auth page that has to be pasted back into this
 * same process's stdin — submitClaudeLoginCode does that once the caller
 * has it. Success/failure is read from the exit code plus a follow-up
 * getClaudeAuthStatus() call, not from scraped text, for the same reason
 * lib/git/gh-login.ts avoids it: the least version-stable part of driving
 * an interactive CLI is its exact wording.
 */
export function startClaudeLogin(): {
  loginId: string;
  events: AsyncGenerator<ClaudeLoginEvent>;
} {
  const loginId = randomUUID();
  const events: ClaudeLoginEvent[] = [];
  let resolveNext: (() => void) | null = null;
  let done = false;

  const push = (event: ClaudeLoginEvent) => {
    events.push(event);
    resolveNext?.();
  };

  push({ type: "status", stage: "starting" });

  const child = spawn(resolveClaudeCliPath(), ["auth", "login", "--claudeai"], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  sessions.set(loginId, { child, push });

  let buffer = "";
  let urlEmitted = false;

  const onData = (chunk: Buffer) => {
    buffer += chunk.toString();
    if (urlEmitted) return;
    const match = buffer.match(URL_PATTERN);
    if (match) {
      urlEmitted = true;
      push({ type: "url", url: match[1] });
    }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);

  const urlTimeout = setTimeout(() => {
    if (urlEmitted || done) return;
    child.kill();
    done = true;
    sessions.delete(loginId);
    push({
      type: "error",
      message: "Timed out waiting for a sign-in link from the CLI.",
      fallback: true,
    });
  }, URL_TIMEOUT_MS);

  const overallTimeout = setTimeout(() => {
    if (done) return;
    child.kill();
    done = true;
    sessions.delete(loginId);
    push({ type: "error", message: "Sign-in timed out.", fallback: true });
  }, OVERALL_TIMEOUT_MS);

  child.on("close", (exitCode) => {
    clearTimeout(urlTimeout);
    clearTimeout(overallTimeout);
    sessions.delete(loginId);
    if (done) return;
    done = true;

    if (exitCode === 0) {
      getClaudeAuthStatus().then((status) => {
        if (status.loggedIn) push({ type: "success" });
        else
          push({
            type: "error",
            message:
              "claude auth login exited cleanly, but you don't appear to be signed in.",
            fallback: true,
          });
      });
      return;
    }
    push({
      type: "error",
      message: buffer.trim() || "claude auth login exited with an error.",
      fallback: true,
    });
  });

  child.on("error", () => {
    clearTimeout(urlTimeout);
    clearTimeout(overallTimeout);
    sessions.delete(loginId);
    if (done) return;
    done = true;
    push({
      type: "error",
      message: "Failed to start the Claude CLI.",
      fallback: true,
    });
  });

  async function* generate(): AsyncGenerator<ClaudeLoginEvent> {
    let idx = 0;
    while (true) {
      while (idx < events.length) {
        yield events[idx];
        idx++;
      }
      if (done && idx >= events.length) break;
      await new Promise<void>((resolve) => {
        resolveNext = resolve;
      });
    }
  }

  return { loginId, events: generate() };
}

/**
 * Writes the code the user pasted back into the still-running login
 * process's stdin. Returns false if loginId doesn't match any in-flight
 * attempt (already finished, expired, or never existed) so the route can
 * surface a clear error instead of silently doing nothing.
 */
export function submitClaudeLoginCode(loginId: string, code: string): boolean {
  const session = sessions.get(loginId);
  if (!session) return false;
  session.child.stdin.write(`${code.trim()}\n`);
  return true;
}

export function cancelClaudeLogin(loginId: string): void {
  const session = sessions.get(loginId);
  if (!session) return;
  session.child.kill();
  sessions.delete(loginId);
}
