import { spawn } from "node:child_process";
import { ghRunOk } from "@/lib/git/gh-runner";

export type GhLoginEvent =
  | { type: "status"; stage: "starting" }
  | { type: "code"; code: string; url: string }
  | { type: "waiting" }
  | { type: "success"; login: string }
  | { type: "error"; message: string; fallback: boolean };

// Device code shape ("XXXX-XXXX") and the verification URL gh prints.
// Matched independently of the surrounding prompt wording, which is the
// most version-fragile part of driving an interactive CLI — reproduced
// directly against the installed version (gh 2.95.0):
//   ! First copy your one-time code: 03A2-BD18
//   Open this URL to continue in your web browser: https://github.com/login/device
// Notably this version needs no keypress to proceed (older/other versions
// may print a "Press Enter to open your browser" prompt instead — since we
// never write to stdin either way, that would just leave the browser
// unopened but the code/URL still usable via the fallback link in the UI).
const CODE_PATTERN = /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/;
const URL_PATTERN = /(https:\/\/github\.com\/login\/device\S*)/;

const CODE_TIMEOUT_MS = 20_000;
const OVERALL_TIMEOUT_MS = 5 * 60_000;

/**
 * Drives `gh auth login --web` (the OAuth device-flow login) and yields
 * progress events. The device code + verification URL are the only output
 * we depend on parsing; success/failure is read from the process exit code,
 * not from text, since that's stable across gh versions. Any failure to
 * parse or an unexpected exit surfaces as fallback:true, which the UI turns
 * into "run gh auth login yourself, then click Refresh" — the safety net
 * for the version fragility inherent in scraping a CLI's human-facing text.
 */
export async function* runGhDeviceLogin(
  signal: AbortSignal,
): AsyncGenerator<GhLoginEvent> {
  yield { type: "status", stage: "starting" };

  const child = spawn(
    "gh",
    [
      "auth",
      "login",
      "--hostname",
      "github.com",
      "--git-protocol",
      "https",
      "--web",
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );

  let buffer = "";
  let codeEmitted = false;
  let done = false;
  const events: GhLoginEvent[] = [];
  let resolveNext: (() => void) | null = null;

  const push = (event: GhLoginEvent) => {
    events.push(event);
    resolveNext?.();
  };

  const onData = (chunk: Buffer) => {
    buffer += chunk.toString();
    if (codeEmitted) return;
    const codeMatch = buffer.match(CODE_PATTERN);
    const urlMatch = buffer.match(URL_PATTERN);
    if (codeMatch && urlMatch) {
      codeEmitted = true;
      push({ type: "code", code: codeMatch[1], url: urlMatch[1] });
      push({ type: "waiting" });
    }
  };

  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);

  const codeTimeout = setTimeout(() => {
    if (codeEmitted || done) return;
    child.kill();
    done = true;
    push({
      type: "error",
      message: "Timed out waiting for a device code from gh.",
      fallback: true,
    });
  }, CODE_TIMEOUT_MS);

  const overallTimeout = setTimeout(() => {
    if (done) return;
    child.kill();
    done = true;
    push({ type: "error", message: "Sign-in timed out.", fallback: true });
  }, OVERALL_TIMEOUT_MS);

  const onAbort = () => child.kill();
  signal.addEventListener("abort", onAbort);

  child.on("close", (exitCode) => {
    clearTimeout(codeTimeout);
    clearTimeout(overallTimeout);
    if (done) return;
    done = true;

    if (exitCode === 0) {
      ghRunOk(["api", "user", "-q", ".login"]).then((login) => {
        push({ type: "success", login: login ?? "unknown" });
      });
      return;
    }
    if (signal.aborted) {
      push({ type: "error", message: "Sign-in cancelled.", fallback: false });
      return;
    }
    push({
      type: "error",
      message: buffer.trim() || "gh auth login exited with an error.",
      fallback: true,
    });
  });

  child.on("error", () => {
    clearTimeout(codeTimeout);
    clearTimeout(overallTimeout);
    if (done) return;
    done = true;
    push({ type: "error", message: "Failed to start gh.", fallback: true });
  });

  try {
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
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
