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

// Helper for extension (optional): GET latest code
export function getLatestCode(jobId: string) {
  return store.get(jobId)?.code ?? null;
}

