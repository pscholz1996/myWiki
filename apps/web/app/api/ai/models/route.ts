import { NextResponse } from "next/server";
import { listSupportedModels } from "@/lib/ai/agent";
import { resolveInstituteModel } from "@/lib/ai/institute-llm";
import {
  type AiModelOption,
  CLAUDE_FALLBACK_OPTIONS,
  DEFAULT_MODEL,
  INSTITUTE_FALLBACK_OPTION,
  toPickerOptions,
} from "@/lib/ai/types";
import { getProjectDir, NoProjectSelectedError } from "@/lib/fs/project-dir";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The composer's model rows: the institute LLM first (the default, answers
 * stay in-house), then the Claude models this account may use.
 *
 * Both lists are asked live and independently — no VPN must not hide
 * Claude, and not being signed in to Claude must not hide the institute.
 * Each falls back to its own built-in rows; `stale: true` says one did.
 */
export async function GET() {
  try {
    const projectDir = getProjectDir();
    const [institute, claude] = await Promise.allSettled([
      resolveInstituteModel(),
      listSupportedModels(projectDir),
    ]);

    const instituteRow: AiModelOption =
      institute.status === "fulfilled"
        ? {
            value: DEFAULT_MODEL,
            resolvedModel: institute.value.id,
            // "google/gemma-4-31B-it" → "gemma-4-31B-it": the org prefix is
            // noise in a footer, the rest is the model's own name.
            displayName:
              institute.value.id.split("/").pop() ?? institute.value.id,
            // The group heading already says the answers stay in-house.
            description: "IEM server",
            provider: "institute",
          }
        : INSTITUTE_FALLBACK_OPTION;

    // toPickerOptions only over Claude's own rows: its "recommended" marker
    // is Anthropic's recommendation among Claude models, not across both.
    const claudeRows: AiModelOption[] =
      claude.status === "fulfilled"
        ? toPickerOptions(claude.value).map((row) => ({
            ...row,
            provider: "claude" as const,
          }))
        : CLAUDE_FALLBACK_OPTIONS;

    for (const [name, result] of [
      ["Institute LLM", institute],
      ["Claude", claude],
    ] as const) {
      if (result.status === "rejected") {
        console.warn(
          `[ai/models] ${name} list unavailable, using built-in rows:`,
          result.reason instanceof Error
            ? result.reason.message
            : result.reason,
        );
      }
    }

    return NextResponse.json({
      models: [instituteRow, ...claudeRows],
      defaultModel: DEFAULT_MODEL,
      stale: institute.status === "rejected" || claude.status === "rejected",
    });
  } catch (error) {
    if (error instanceof NoProjectSelectedError) {
      return NextResponse.json(
        { error: "no-project-selected" },
        { status: 409 },
      );
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
