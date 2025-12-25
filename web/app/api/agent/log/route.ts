import { NextRequest, NextResponse } from "next/server";
import { corsHeaders } from "@/lib/cors";

export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  
  // Just print logs for now
  console.log("[agent-log]", body);
  
  return NextResponse.json({ ok: true }, { headers: corsHeaders });
}

