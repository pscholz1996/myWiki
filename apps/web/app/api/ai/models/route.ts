import { NextResponse } from "next/server";
import { resolveInstituteModel } from "@/lib/ai/institute-llm";
import {
  type AiModelOption,
  DEFAULT_MODEL,
  FALLBACK_MODEL_OPTIONS,
} from "@/lib/ai/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The composer's model row. The chat runs on the institute server, which
 * serves one model at a time, so this is one row naming whichever model is
 * loaded right now — asked from the server, never assumed.
 *
 * A failure is never fatal: no VPN is a normal state, and the chat itself
 * explains it when a message is sent. `stale: true` tells the client the
 * row is the fallback.
 */
export async function GET() {
  try {
    const model = await resolveInstituteModel();
    const row: AiModelOption = {
      value: DEFAULT_MODEL,
      resolvedModel: model.id,
      // "google/gemma-4-31B-it" → "gemma-4-31B-it": the org prefix is noise
      // in a footer, the rest is the model's own name.
      displayName: model.id.split("/").pop() ?? model.id,
      description: "IEM server · answers stay in-house · visuals by Claude",
    };
    return NextResponse.json({
      models: [row],
      defaultModel: DEFAULT_MODEL,
      stale: false,
    });
  } catch (error) {
    console.warn(
      "[ai/models] Institute LLM not reachable:",
      error instanceof Error ? error.message : error,
    );
    return NextResponse.json({
      models: FALLBACK_MODEL_OPTIONS,
      defaultModel: DEFAULT_MODEL,
      stale: true,
    });
  }
}
