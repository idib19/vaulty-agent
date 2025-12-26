import { NextRequest, NextResponse } from "next/server";
import { corsHeaders } from "@/lib/cors";

// In-memory store for MVP. In production, use Redis/DB.
const store = new Map<string, { code: string; updatedAt: number }>();

export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { jobId, code } = body || {};

  if (!jobId || !code) {
    return NextResponse.json(
      { error: "jobId and code required" },
      { status: 400, headers: corsHeaders }
    );
  }

  store.set(jobId, { code: String(code), updatedAt: Date.now() });
  return NextResponse.json({ ok: true }, { headers: corsHeaders });
}

// Helper function (internal only - not exported to avoid Next.js route validation errors)
function getLatestCode(jobId: string) {
  return store.get(jobId)?.code ?? null;
}

// GET endpoint to retrieve latest code (for extension use)
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const jobId = searchParams.get("jobId");

  if (!jobId) {
    return NextResponse.json(
      { error: "jobId required" },
      { status: 400, headers: corsHeaders }
    );
  }

  const code = getLatestCode(jobId);
  return NextResponse.json({ ok: true, code }, { headers: corsHeaders });
}

