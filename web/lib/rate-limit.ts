import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { cors } from "@/lib/cors";

export type AgentEndpoint = "fill" | "copilot";

const DAILY_LIMIT = 10;

/**
 * Check whether the user has remaining daily requests, and record usage
 * if they do. Returns null when the request is allowed, or a 429 response
 * to return immediately when the limit has been reached.
 *
 * Uses the caller's JWT so RLS keeps users scoped to their own rows.
 */
export async function enforceRateLimit(
  request: Request,
  token: string,
  userId: string,
  endpoint: AgentEndpoint
): Promise<NextResponse | null> {
  const client = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_ANON_KEY!,
    {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    }
  );

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  const { count, error } = await client
    .from("agent_daily_usage")
    .select("*", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("used_at", today);

  if (error) {
    console.error("[rate-limit] Failed to read usage:", error);
    return NextResponse.json(
      { error: "usage_check_failed", message: "We couldn't verify your usage right now. Please try again in a moment." },
      { status: 500, headers: cors(request) }
    );
  }

  const used = count ?? 0;

  if (used >= DAILY_LIMIT) {
    const midnight = new Date();
    midnight.setUTCDate(midnight.getUTCDate() + 1);
    midnight.setUTCHours(0, 0, 0, 0);

    return NextResponse.json(
      {
        error: "daily_limit_reached",
        message: `You've used all ${DAILY_LIMIT} AI requests for today. Resets at midnight UTC.`,
        limit: DAILY_LIMIT,
        used,
        resetsAt: midnight.toISOString(),
      },
      { status: 429, headers: cors(request) }
    );
  }

  const { error: insertError } = await client
    .from("agent_daily_usage")
    .insert({ user_id: userId, endpoint });

  if (insertError) {
    console.error("[rate-limit] Failed to record usage:", insertError);
    // Non-fatal — allow the request through but log the failure.
    // The next request will still count correctly.
  }

  return null; // allowed
}
