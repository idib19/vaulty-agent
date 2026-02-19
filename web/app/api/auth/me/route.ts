import { NextRequest, NextResponse } from "next/server";
import { cors } from "@/lib/cors";
import { verifyExtensionAuth, isAuthError } from "@/lib/auth";
import { supabase } from "@/lib/supabase";

export async function OPTIONS(request: NextRequest) {
  return NextResponse.json({}, { headers: cors(request) });
}

export async function GET(request: NextRequest) {
  const auth = await verifyExtensionAuth(request);
  if (isAuthError(auth)) return auth;

  // Re-fetch tier so the response always reflects the current state
  const { data: profile } = await supabase
    .from("user_profiles")
    .select("tier")
    .eq("user_id", auth.userId)
    .single();

  return NextResponse.json(
    {
      user: { id: auth.userId, email: auth.email },
      isPro: true,
      tier: profile?.tier ?? null,
    },
    { headers: cors(request) }
  );
}
