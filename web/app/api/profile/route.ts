import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { cors } from "@/lib/cors";
import type { UserProfile } from "@/lib/profile";
import { verifyExtensionAuth, isAuthError } from "@/lib/auth";
import { getFullName } from "@/lib/profile";

function userClient(token: string) {
  return createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_ANON_KEY!,
    {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    }
  );
}

export async function OPTIONS(request: NextRequest) {
  return NextResponse.json({}, { headers: cors(request) });
}

export async function GET(request: NextRequest) {
  const auth = await verifyExtensionAuth(request);
  if (isAuthError(auth)) return auth;

  const sb = userClient(auth.token);
  const { data, error } = await sb
    .from("user_profiles")
    .select("profile_data")
    .eq("user_id", auth.userId)
    .single();

  if (error || !data) {
    return NextResponse.json(
      { error: "Profile not found", profile: null },
      { status: 404, headers: cors(request) }
    );
  }

  return NextResponse.json(
    { profile: data.profile_data ?? {} },
    { headers: cors(request) }
  );
}

export async function POST(request: NextRequest) {
  const auth = await verifyExtensionAuth(request);
  if (isAuthError(auth)) return auth;

  const body = await request.json();
  const profile: UserProfile | undefined = body.profile;

  if (!profile) {
    return NextResponse.json(
      { error: "profile is required" },
      { status: 400, headers: cors(request) }
    );
  }

  const profileWithMeta: UserProfile = {
    ...profile,
    updatedAt: new Date().toISOString(),
  };

  const sb = userClient(auth.token);
  const { error } = await sb
    .from("user_profiles")
    .update({
      profile_data: profileWithMeta,
      full_name: getFullName(profileWithMeta),
      email: profileWithMeta.email || undefined,
      phone: profileWithMeta.phone || undefined,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", auth.userId);

  if (error) {
    console.error("[profile] Supabase update error:", error);
    return NextResponse.json(
      { error: "save_failed", message: "Could not save profile. Please try again." },
      { status: 500, headers: cors(request) }
    );
  }

  return NextResponse.json(
    { ok: true, profile: profileWithMeta },
    { headers: cors(request) }
  );
}

export async function DELETE(request: NextRequest) {
  const auth = await verifyExtensionAuth(request);
  if (isAuthError(auth)) return auth;

  const sb = userClient(auth.token);
  const { error } = await sb
    .from("user_profiles")
    .update({ profile_data: {}, updated_at: new Date().toISOString() })
    .eq("user_id", auth.userId);

  if (error) {
    console.error("[profile] Supabase clear error:", error);
    return NextResponse.json(
      { error: "clear_failed", message: "Could not clear profile. Please try again." },
      { status: 500, headers: cors(request) }
    );
  }

  return NextResponse.json({ ok: true }, { headers: cors(request) });
}
