import { NextResponse } from "next/server";
import { GhNotInstalledError, ghRun, ghRunOk } from "@/lib/git/gh-runner";

export const dynamic = "force-dynamic";

export interface GhUser {
  login: string;
  name: string | null;
  avatarUrl: string | null;
}

export interface GhStatus {
  installed: boolean;
  version: string | null;
  authenticated: boolean;
  user: GhUser | null;
}

// Account-level state — no getProjectDir() here, gh auth persists across
// every project, not scoped to whichever one happens to be open.
export async function GET() {
  try {
    const versionOutput = await ghRunOk(["--version"]);
    if (!versionOutput) {
      return NextResponse.json({
        installed: true,
        version: null,
        authenticated: false,
        user: null,
      } satisfies GhStatus);
    }
    const version =
      versionOutput.match(/^gh version (\S+)/)?.[1] ?? null;

    const authResult = await ghRun(["auth", "status", "--hostname", "github.com"]);
    if (authResult.exitCode !== 0) {
      return NextResponse.json({
        installed: true,
        version,
        authenticated: false,
        user: null,
      } satisfies GhStatus);
    }

    const userJson = await ghRunOk([
      "api",
      "user",
      "-q",
      "{login: .login, name: .name, avatarUrl: .avatar_url}",
    ]);
    let user: GhUser | null = null;
    if (userJson) {
      try {
        const parsed = JSON.parse(userJson);
        user = {
          login: parsed.login ?? "unknown",
          name: parsed.name ?? null,
          avatarUrl: parsed.avatarUrl ?? null,
        };
      } catch {
        user = null;
      }
    }

    return NextResponse.json({
      installed: true,
      version,
      authenticated: true,
      user,
    } satisfies GhStatus);
  } catch (error) {
    if (error instanceof GhNotInstalledError) {
      return NextResponse.json({
        installed: false,
        version: null,
        authenticated: false,
        user: null,
      } satisfies GhStatus);
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
