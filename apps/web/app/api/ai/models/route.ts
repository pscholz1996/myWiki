import { NextResponse } from "next/server";
import { listSupportedModels } from "@/lib/ai/agent";
import { getProjectDir, NoProjectSelectedError } from "@/lib/fs/project-dir";
import {
  DEFAULT_MODEL,
  FALLBACK_MODEL_OPTIONS,
  toPickerOptions,
} from "@/lib/ai/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Rows for the composer's model picker. The list comes from the Claude CLI
 * itself, so it reflects what this account's plan actually allows rather
 * than a catalog baked into the app.
 *
 * A failure here is never fatal: not being signed in yet is the normal
 * first-run state, and an empty picker would be a worse answer than a
 * generic one. `stale: true` tells the client the list is the fallback.
 *
 * Both branches go through toPickerOptions, so the client never has to know
 * that the SDK reports a redundant "default" row.
 */
export async function GET() {
  try {
    const projectDir = getProjectDir();
    const models = toPickerOptions(await listSupportedModels(projectDir));
    return NextResponse.json({
      models,
      defaultModel: DEFAULT_MODEL,
      stale: false,
    });
  } catch (error) {
    if (error instanceof NoProjectSelectedError) {
      return NextResponse.json(
        { error: "no-project-selected" },
        { status: 409 },
      );
    }
    console.warn(
      "[ai/models] Falling back to the built-in model list:",
      error instanceof Error ? error.message : error,
    );
    return NextResponse.json({
      models: toPickerOptions(FALLBACK_MODEL_OPTIONS),
      defaultModel: DEFAULT_MODEL,
      stale: true,
    });
  }
}
