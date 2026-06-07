import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { mkdir, rm, writeFile, readFile, access } from "node:fs/promises";
import { dirname, join, resolve, sep, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { gunzipSync, gzipSync } from "node:zlib";

const app = new Hono();

const MAX_CONCURRENT = 3;
const COMPILE_TIMEOUT_MS = 300000; // 5 minutes — allows time for on-the-fly package installs
const MAX_AUTO_INSTALL_RETRIES = 3;

// SyncTeX workdir retention.
const MAX_RETAINED_BUILDS = 8;
const BUILD_TTL_MS = 10 * 60 * 1000; // 10 minutes

let activeCompilations = 0;

interface RetainedBuild {
  workDir: string;
  mainFileName: string; // without .tex extension
  createdAt: number;
  /**
   * True for disk-backed builds registered via /builds/register, whose workDir
   * is a caller-owned directory (the project's persisted build dir). Eviction
   * must NOT delete it — only drop the in-memory entry.
   */
  persistent?: boolean;
}

const builds = new Map<string, RetainedBuild>();

/** Evict builds that are too old or beyond the size cap. */
async function evictStaleBuilds() {
  const now = Date.now();
  const entries = [...builds.entries()];

  // Drop anything older than TTL. Persistent (disk-backed) builds own their
  // workDir — only forget the entry, never delete the directory.
  for (const [id, b] of entries) {
    if (now - b.createdAt > BUILD_TTL_MS) {
      builds.delete(id);
      if (!b.persistent) {
        await rm(b.workDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  // Drop oldest until we're at or below the size cap.
  while (builds.size > MAX_RETAINED_BUILDS) {
    let oldestId: string | null = null;
    let oldestAt = Infinity;
    for (const [id, b] of builds) {
      if (b.createdAt < oldestAt) {
        oldestAt = b.createdAt;
        oldestId = id;
      }
    }
    if (!oldestId) break;
    const dropped = builds.get(oldestId);
    builds.delete(oldestId);
    if (dropped && !dropped.persistent) {
      await rm(dropped.workDir, { recursive: true, force: true }).catch(
        () => {},
      );
    }
  }
}

/** Parse a LaTeX log for missing .sty / .cls files */
function findMissingPackageFiles(logContent: string): string[] {
  const missing = new Set<string>();
  for (const m of logContent.matchAll(
    /! LaTeX Error: File `([^']+)' not found/g,
  )) {
    missing.add(m[1]);
  }
  return [...missing];
}

/** Ask tlmgr to install packages by file-stem name */
function installTexPackages(fileNames: string[]): Promise<boolean> {
  const pkgNames = fileNames.map((f) => f.replace(/\.[^.]+$/, ""));
  return new Promise((resolve) => {
    const proc = spawn("tlmgr", ["install", ...pkgNames], {
      stdio: "ignore",
    });
    proc.on("close", (code) => resolve(code === 0));
    proc.on("error", () => resolve(false));
  });
}

function sanitizePath(workDir: string, filePath: string): string | null {
  if (filePath.includes("..")) return null;
  const normalized = resolve(workDir, filePath);
  const workDirWithSep =
    workDir.endsWith("/") || workDir.endsWith("\\")
      ? workDir
      : `${workDir}${sep}`;
  if (!normalized.startsWith(workDirWithSep) && normalized !== workDir) {
    return null;
  }
  return normalized;
}

/**
 * Run a subprocess to completion and capture stdout. Used for the synctex CLI.
 */
function runCapture(
  cmd: string,
  args: string[],
  cwd?: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("close", (code) => {
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
    proc.on("error", () => {
      resolve({ exitCode: 1, stdout, stderr });
    });
  });
}

/**
 * Parse `synctex view` output. The CLI prints one or more blocks separated by
 * SyncTeX result/Output markers. We take the first block.
 */
function parseSyncTeXView(stdout: string): {
  page: number;
  x: number;
  y: number;
  h: number;
  v: number;
  width: number;
  height: number;
} | null {
  const get = (key: string): number | null => {
    const re = new RegExp(`^${key}:(.+)$`, "m");
    const m = stdout.match(re);
    return m ? parseFloat(m[1]) : null;
  };
  const page = get("Page");
  const x = get("x");
  const y = get("y");
  if (page == null || x == null || y == null) return null;
  const h = get("h") ?? x;
  const v = get("v") ?? y;
  const width = get("W") ?? 0;
  const height = get("H") ?? 0;
  return { page, x, y, h, v, width, height };
}

/**
 * Parse `synctex edit` output. Returns the first match.
 */
function parseSyncTeXEdit(
  stdout: string,
): { input: string; line: number; column: number } | null {
  const inputMatch = stdout.match(/^Input:(.+)$/m);
  const lineMatch = stdout.match(/^Line:(\d+)$/m);
  const colMatch = stdout.match(/^Column:(-?\d+)$/m);
  if (!inputMatch || !lineMatch) return null;
  return {
    input: inputMatch[1].trim(),
    line: parseInt(lineMatch[1], 10),
    column: colMatch ? Math.max(0, parseInt(colMatch[1], 10)) : 0,
  };
}

app.use("/*", cors({ origin: "*", exposeHeaders: ["X-Build-Id"] }));
app.use("/*", bodyLimit({ maxSize: 50 * 1024 * 1024 }));

interface Resource {
  path?: string;
  content?: string;
  file?: string;
  main?: boolean;
}

interface CompileRequest {
  compiler?: string;
  resources: Resource[];
}

interface CompileError {
  error: string;
  log_files?: Record<string, string>;
}

app.get("/", (c) => {
  return c.json({ status: "ok", service: "latex-api" });
});

app.post("/builds/sync", async (c) => {
  if (activeCompilations >= MAX_CONCURRENT) {
    return c.json(
      { error: "Server busy, try again later" } satisfies CompileError,
      503,
    );
  }

  const body = await c.req.json<CompileRequest>();
  const { compiler = "pdflatex", resources } = body;

  if (!resources || resources.length === 0) {
    return c.json(
      { error: "No resources provided" } satisfies CompileError,
      400,
    );
  }

  const mainResource = resources.find((r) => r.main) || resources[0];
  const mainPath = mainResource.path || "main.tex";
  const mainFileName = mainPath.replace(/\.tex$/, "");

  const buildId = randomUUID();
  const workDir = join(tmpdir(), `latex-${buildId}`);
  await mkdir(workDir, { recursive: true });

  let keepWorkDir = false;

  activeCompilations++;
  try {
    const hasBib = resources.some((r) => r.path?.endsWith(".bib"));

    for (const resource of resources) {
      const filePath =
        resource.path || (resource.main ? "main.tex" : `file-${randomUUID()}`);
      const fullPath = sanitizePath(workDir, filePath);

      if (!fullPath) {
        return c.json({ error: "Invalid path" } satisfies CompileError, 400);
      }

      const parentDir = dirname(fullPath);
      if (parentDir !== workDir) {
        await mkdir(parentDir, { recursive: true });
      }

      if (resource.file) {
        const buffer = Buffer.from(resource.file, "base64");
        await writeFile(fullPath, buffer);
      } else if (resource.content) {
        await writeFile(fullPath, resource.content, "utf-8");
      }
    }

    const compilerCmd =
      compiler === "xelatex"
        ? "xelatex"
        : compiler === "lualatex"
          ? "lualatex"
          : "pdflatex";

    const runWithTimeout = (
      cmd: string[],
    ): Promise<{ exitCode: number; timedOut: boolean }> => {
      return new Promise((resolve) => {
        const [command, ...args] = cmd;
        const proc = spawn(command, args, {
          cwd: workDir,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let timedOut = false;
        const timeout = setTimeout(() => {
          timedOut = true;
          proc.kill();
        }, COMPILE_TIMEOUT_MS);
        proc.on("close", (code) => {
          clearTimeout(timeout);
          resolve({ exitCode: code ?? 1, timedOut });
        });
        proc.on("error", () => {
          clearTimeout(timeout);
          resolve({ exitCode: 1, timedOut: false });
        });
      });
    };

    const latexCmd = [
      compilerCmd,
      "-interaction=nonstopmode",
      "-synctex=1",
      mainPath,
    ];
    const logPath = join(workDir, `${mainFileName}.log`);

    // Helper: run first pass then auto-install any missing LaTeX packages
    const firstPassWithAutoInstall = async () => {
      let result = await runWithTimeout(latexCmd);
      if (result.timedOut) return { timedOut: true } as const;

      for (let attempt = 0; attempt < MAX_AUTO_INSTALL_RETRIES; attempt++) {
        let logText = "";
        try {
          logText = await readFile(logPath, "utf-8");
        } catch {}
        const missingFiles = findMissingPackageFiles(logText);
        if (missingFiles.length === 0) break;
        const installed = await installTexPackages(missingFiles);
        if (!installed) break;
        result = await runWithTimeout(latexCmd);
        if (result.timedOut) return { timedOut: true } as const;
      }
      return { timedOut: false };
    };

    if (hasBib) {
      const first = await firstPassWithAutoInstall();
      if (first.timedOut) {
        return c.json(
          { error: "Compilation timed out" } satisfies CompileError,
          500,
        );
      }

      const auxPath = join(workDir, `${mainFileName}.aux`);
      const auxExists = await access(auxPath)
        .then(() => true)
        .catch(() => false);
      let result;
      if (auxExists) {
        result = await runWithTimeout(["bibtex", mainFileName]);
        if (result.timedOut) {
          return c.json(
            { error: "BibTeX timed out" } satisfies CompileError,
            500,
          );
        }
      }

      for (let i = 0; i < 2; i++) {
        result = await runWithTimeout(latexCmd);
        if (result.timedOut) {
          return c.json(
            { error: "Compilation timed out" } satisfies CompileError,
            500,
          );
        }
      }
    } else {
      const first = await firstPassWithAutoInstall();
      if (first.timedOut) {
        return c.json(
          { error: "Compilation timed out" } satisfies CompileError,
          500,
        );
      }

      // Second pass (resolves cross-references)
      const result = await runWithTimeout(latexCmd);
      if (result.timedOut) {
        return c.json(
          { error: "Compilation timed out" } satisfies CompileError,
          500,
        );
      }
    }

    const pdfPath = join(workDir, `${mainFileName}.pdf`);

    let logContent = "";
    try {
      logContent = await readFile(logPath, "utf-8");
    } catch {}

    try {
      const pdfBuffer = await readFile(pdfPath);
      // Successful compile: retain the workdir so /synctex/* can query
      // its .synctex.gz. Eviction below keeps disk usage bounded.
      builds.set(buildId, {
        workDir,
        mainFileName,
        createdAt: Date.now(),
      });
      keepWorkDir = true;
      // Fire-and-forget eviction; we don't need to wait.
      evictStaleBuilds().catch(() => {});
      return new Response(pdfBuffer, {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `inline; filename=${mainFileName}.pdf`,
          "X-Build-Id": buildId,
          "Access-Control-Expose-Headers": "X-Build-Id",
        },
      });
    } catch {
      return c.json(
        {
          error: "Compilation failed",
          log_files: {
            "__main_document__.log": logContent,
          },
        } satisfies CompileError,
        500,
      );
    }
  } finally {
    activeCompilations--;
    if (!keepWorkDir) {
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }
});

interface SyncForwardRequest {
  buildId: string;
  file: string; // project-relative path of the .tex file, matching what was sent on compile
  line: number; // 1-based
  column?: number; // 0-based, default 0
}

interface SyncInverseRequest {
  buildId: string;
  page: number; // 1-based
  x: number; // PDF points, origin top-left
  y: number; // PDF points, origin top-left
}

app.post("/synctex/forward", async (c) => {
  const body = await c.req.json<SyncForwardRequest>();
  const build = builds.get(body.buildId);
  if (!build) {
    console.log("[synctex] forward: build-not-found", body.buildId);
    return c.json({ error: "build-not-found" }, 404);
  }

  // Refresh TTL — recently used builds stay around longer.
  build.createdAt = Date.now();

  // Confirm a .synctex.gz exists; if not, synctex was disabled for this doc.
  const synctexPath = join(build.workDir, `${build.mainFileName}.synctex.gz`);
  const hasSynctex = await access(synctexPath)
    .then(() => true)
    .catch(() => false);
  if (!hasSynctex) {
    console.log("[synctex] forward: no .synctex.gz at", synctexPath);
    return c.json({ error: "synctex-disabled" }, 422);
  }

  // `synctex view -i line:column:inputfile -o outpdf`
  //
  // The `inputfile` arg must match the path string the TeX engine recorded
  // in `.synctex.gz`. The engine stores **absolute** paths with native
  // separators (backslashes on Windows). The client sends us a
  // project-relative POSIX path (e.g. `content/03-method.tex`), so join it
  // onto the workdir to produce the exact absolute path synctex indexed.
  const column = Math.max(0, body.column ?? 0);
  const pdfPath = join(build.workDir, `${build.mainFileName}.pdf`);
  const absInput = join(build.workDir, body.file);
  const inputArg = `${body.line}:${column}:${absInput}`;
  console.log("[synctex] forward args:", inputArg, "->", pdfPath);
  const result = await runCapture(
    "synctex",
    ["view", "-i", inputArg, "-o", pdfPath],
    build.workDir,
  );
  console.log(
    "[synctex] forward exitCode=",
    result.exitCode,
    "stdout=\n",
    result.stdout,
    "stderr=\n",
    result.stderr,
  );
  if (result.exitCode !== 0 && !result.stdout.includes("Output:")) {
    return c.json({ error: "synctex-failed", details: result.stderr }, 500);
  }
  const parsed = parseSyncTeXView(result.stdout);
  if (!parsed) {
    console.log("[synctex] forward parsed=null (no match)");
    return c.body(null, 204);
  }
  console.log("[synctex] forward parsed=", parsed);
  return c.json(parsed);
});

app.post("/synctex/inverse", async (c) => {
  const body = await c.req.json<SyncInverseRequest>();
  const build = builds.get(body.buildId);
  if (!build) {
    return c.json({ error: "build-not-found" }, 404);
  }

  build.createdAt = Date.now();

  const synctexPath = join(build.workDir, `${build.mainFileName}.synctex.gz`);
  const hasSynctex = await access(synctexPath)
    .then(() => true)
    .catch(() => false);
  if (!hasSynctex) {
    return c.json({ error: "synctex-disabled" }, 422);
  }

  const pdfPath = join(build.workDir, `${build.mainFileName}.pdf`);
  const editArg = `${body.page}:${body.x}:${body.y}:${pdfPath}`;
  const result = await runCapture(
    "synctex",
    ["edit", "-o", editArg],
    build.workDir,
  );
  if (result.exitCode !== 0 && !result.stdout.includes("Input:")) {
    return c.json({ error: "synctex-failed", details: result.stderr }, 500);
  }
  const parsed = parseSyncTeXEdit(result.stdout);
  if (!parsed) {
    return c.body(null, 204);
  }

  // Normalize the returned path. synctex may give us an absolute path or one
  // relative to workDir. We want the project-relative path (the same one the
  // client sent during compile) — that's just the path relative to workDir.
  let normalized = parsed.input;
  if (isAbsolute(normalized)) {
    const rel = relative(build.workDir, normalized);
    if (rel.startsWith("..")) {
      // Outside the workdir — must be a system file we can't open.
      return c.json({ error: "outside-project" }, 404);
    }
    normalized = rel;
  }
  normalized = normalized.replace(/\\/g, "/");

  return c.json({
    file: normalized,
    line: parsed.line,
    column: parsed.column,
  });
});

/**
 * Return this build's `.synctex.gz` with its recorded paths rewritten so the
 * caller can persist it next to a relocated/renamed PDF and still query it.
 *
 * SyncTeX records native absolute source paths at compile time (the tmp
 * workDir). When the build is later replayed from disk (e.g. the project's
 * persisted `out.pdf` + `out.synctex.gz`), forward sync's `-i` input path must
 * match those recorded strings. We rewrite the workDir prefix → the caller's
 * `targetDir`, and the `Output:` PDF basename `<mainFileName>.pdf` → `out.pdf`,
 * so the persisted build resolves with `workDir = targetDir`, mainFileName="out".
 */
interface SyncRewriteRequest {
  targetDir: string; // absolute dir where out.pdf + out.synctex.gz will live
}

app.post("/builds/:id/synctex", async (c) => {
  const id = c.req.param("id");
  const build = builds.get(id);
  if (!build) {
    return c.json({ error: "build-not-found" }, 404);
  }
  const body = await c.req.json<SyncRewriteRequest>().catch(() => null);
  if (!body || !body.targetDir) {
    return c.json({ error: "invalid-request" }, 400);
  }

  const synctexPath = join(build.workDir, `${build.mainFileName}.synctex.gz`);
  let raw: Buffer;
  try {
    raw = await readFile(synctexPath);
  } catch {
    return c.json({ error: "synctex-disabled" }, 422);
  }

  let text = gunzipSync(raw).toString("utf-8");
  // Rewrite the recorded source prefix (tmp workDir) → the persisted target dir,
  // and the PDF basename → out.pdf, preserving native separators.
  const fromPrefix = build.workDir.endsWith(sep)
    ? build.workDir
    : `${build.workDir}${sep}`;
  const toPrefix = body.targetDir.endsWith(sep)
    ? body.targetDir
    : `${body.targetDir}${sep}`;
  text = text.split(fromPrefix).join(toPrefix);
  text = text.split(`${build.mainFileName}.pdf`).join("out.pdf");

  const out = gzipSync(Buffer.from(text, "utf-8"));
  return new Response(out, {
    headers: { "Content-Type": "application/gzip" },
  });
});

/**
 * Register a disk-backed build so SyncTeX queries can run against a persisted
 * `out.pdf` + `out.synctex.gz` (e.g. the cached PDF loaded at startup) without
 * recompiling. The caller passes the absolute directory containing those files.
 * Local single-machine app: trusting an absolute path from the co-located web
 * server is acceptable.
 */
interface RegisterRequest {
  workDir: string; // absolute dir containing out.pdf + out.synctex.gz
  mainFileName: string; // e.g. "out"
}

app.post("/builds/register", async (c) => {
  const body = await c.req.json<RegisterRequest>().catch(() => null);
  if (!body || !body.workDir || !body.mainFileName) {
    return c.json({ error: "invalid-request" }, 400);
  }
  const pdfPath = join(body.workDir, `${body.mainFileName}.pdf`);
  const gzPath = join(body.workDir, `${body.mainFileName}.synctex.gz`);
  const ok =
    (await access(pdfPath)
      .then(() => true)
      .catch(() => false)) &&
    (await access(gzPath)
      .then(() => true)
      .catch(() => false));
  if (!ok) {
    return c.json({ error: "artifacts-missing" }, 404);
  }

  const buildId = randomUUID();
  builds.set(buildId, {
    workDir: body.workDir,
    mainFileName: body.mainFileName,
    createdAt: Date.now(),
    persistent: true,
  });
  evictStaleBuilds().catch(() => {});
  return c.json({ buildId });
});

const port = parseInt(process.env.PORT || "3001", 10);

serve({
  fetch: app.fetch,
  port,
});

console.log(`LaTeX API server running on port ${port}`);
