import { NextRequest, NextResponse } from "next/server";
import { cors } from "@/lib/cors";

export async function OPTIONS(request: NextRequest) {
  return NextResponse.json({}, { headers: cors(request) });
}

export async function POST(request: NextRequest) {
  // The extension will clear its own tokens.
  // We just acknowledge the logout — Supabase JWTs are stateless,
  // so server-side invalidation requires the admin API which has
  // rate limits. The short-lived access token expiry (1h) is sufficient.
  const authHeader = request.headers.get("Authorization");
  if (!authHeader) {
    return NextResponse.json({ ok: true }, { headers: cors(request) });
  }

  return NextResponse.json({ ok: true }, { headers: cors(request) });
}
