import { NextResponse } from "next/server";
import { getPlanUsage } from "@/lib/ai/agent";
import { getProjectDir, NoProjectSelectedError } from "@/lib/fs/project-dir";
import type { AiPlanUsage } from "@/lib/ai/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Only available once a live Claude Agent SDK session exists for this
// project — that session is created lazily on the first chat message (see
// lib/ai/agent.ts), so `usage: null` is the normal, expected response
// before the user has sent anything yet, not an error.
export async function GET() {
  try {
    const projectDir = getProjectDir();
    const raw = await getPlanUsage(projectDir);

    if (!raw || !raw.rate_limits_available || !raw.rate_limits) {
      return NextResponse.json({ usage: null });
    }

    const fiveHour = raw.rate_limits.five_hour;
    const sevenDay = raw.rate_limits.seven_day;
    const usage: AiPlanUsage = {
      subscriptionType: raw.subscription_type,
      sessionCostUsd: raw.session.total_cost_usd,
      fiveHour:
        fiveHour && typeof fiveHour.utilization === "number"
          ? { utilization: fiveHour.utilization, resetsAt: fiveHour.resets_at }
          : null,
      sevenDay:
        sevenDay && typeof sevenDay.utilization === "number"
          ? { utilization: sevenDay.utilization, resetsAt: sevenDay.resets_at }
          : null,
    };

    return NextResponse.json({ usage });
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
