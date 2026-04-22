import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface Config {
  currentProject: string | null;
  recentProjects: string[];
}

const DEFAULT_CONFIG: Config = { currentProject: null, recentProjects: [] };
const RECENT_CAP = 10;

let configPathOverride: string | null = null;

/** Test-only: override the config path. Pass null to reset. */
export function _setConfigPathForTesting(p: string | null): void {
  configPathOverride = p;
}

function configPath(): string {
  if (configPathOverride) return configPathOverride;
  return path.join(os.homedir(), ".openlatex", "config.json");
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function writeConfig(cfg: Config): void {
  const p = configPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2), "utf8");
}

export function getConfig(): Config {
  const p = configPath();
  if (!fs.existsSync(p)) return { ...DEFAULT_CONFIG };
  try {
    const raw = fs.readFileSync(p, "utf8");
    const parsed = JSON.parse(raw) as Partial<Config>;
    return {
      currentProject:
        typeof parsed.currentProject === "string"
          ? parsed.currentProject
          : null,
      recentProjects: Array.isArray(parsed.recentProjects)
        ? parsed.recentProjects.filter((x) => typeof x === "string")
        : [],
    };
  } catch {
    console.warn(
      `[openlatex] Could not parse ${p}; using empty defaults. The file will be overwritten on the next save.`,
    );
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * Returns the absolute path of the currently-selected project if it exists.
 * If no project is selected and PROJECT_DIR is set to an existing directory,
 * bootstraps the config from that env var (writes it to disk) and returns it.
 * Otherwise returns null.
 */
export function readCurrentProject(): string | null {
  const cfg = getConfig();
  if (cfg.currentProject && isDirectory(cfg.currentProject)) {
    return path.resolve(cfg.currentProject);
  }

  const env = process.env.PROJECT_DIR?.trim();
  if (env && isDirectory(env)) {
    const resolved = path.resolve(env);
    const recent = [
      resolved,
      ...cfg.recentProjects.filter((p) => p !== resolved),
    ].slice(0, RECENT_CAP);
    writeConfig({ currentProject: resolved, recentProjects: recent });
    return resolved;
  }

  return null;
}

/**
 * Validates the path, then writes it as the current project and bumps it to
 * the front of recentProjects (capped at 10).
 */
export function setCurrentProject(absPath: string): void {
  if (!absPath || !absPath.trim()) {
    throw new Error("Project path is empty.");
  }
  const resolved = path.resolve(absPath.trim());
  if (!fs.existsSync(resolved)) {
    throw new Error(`Project path does not exist: ${resolved}`);
  }
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    throw new Error(`Project path is not a directory: ${resolved}`);
  }

  const cfg = getConfig();
  const recent = [
    resolved,
    ...cfg.recentProjects.filter((p) => p !== resolved),
  ].slice(0, RECENT_CAP);
  writeConfig({ currentProject: resolved, recentProjects: recent });
}

/** Returns recentProjects filtered to directories that still exist on disk. */
export function getRecentProjects(): string[] {
  return getConfig().recentProjects.filter((p) => isDirectory(p));
}
