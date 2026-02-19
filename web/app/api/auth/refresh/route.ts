import { NextRequest, NextResponse } from "next/server";
import { cors } from "@/lib/cors";
import { supabase } from "@/lib/supabase";

export async function OPTIONS(request: NextRequest) {
  return NextResponse.json({}, { headers: cors(request) });
}

export async function POST(request: NextRequest) {
  let body: { refreshToken?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "invalid_request", message: "Something went wrong. Please try signing in again." },
      { status: 400, headers: cors(request) }
    );
  }

  const { refreshToken } = body;
  if (!refreshToken) {
    return NextResponse.json(
      { error: "missing_token", message: "Your session could not be refreshed. Please sign in again." },
      { status: 400, headers: cors(request) }
    );
  }

  const { data, error } = await supabase.auth.refreshSession({
    refresh_token: refreshToken,
  });

  if (error || !data.session) {
    return NextResponse.json(
      { error: "token_expired", message: "Your session has expired. Please sign in again." },
      { status: 401, headers: cors(request) }
    );
  }

  const session = data.session;

  return NextResponse.json(
    {
      accessToken: session.access_token,
      refreshToken: session.refresh_token,
      expiresAt: session.expires_at,
    },
    { headers: cors(request) }
  );
}
