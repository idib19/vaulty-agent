import { NextRequest, NextResponse } from "next/server";
import { cors } from "@/lib/cors";
import { supabase } from "@/lib/supabase";
import { createClient } from "@supabase/supabase-js";

const LOGIN_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const LOGIN_MAX_ATTEMPTS = 5;
const loginAttempts = new Map<string, { count: number; resetAt: number }>();

function checkLoginRate(ip: string): number | null {
  const now = Date.now();
  const entry = loginAttempts.get(ip);

  if (!entry || now >= entry.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return null;
  }

  entry.count++;
  if (entry.count > LOGIN_MAX_ATTEMPTS) {
    return Math.ceil((entry.resetAt - now) / 1000);
  }
  return null;
}

export async function OPTIONS(request: NextRequest) {
  return NextResponse.json({}, { headers: cors(request) });
}

export async function POST(request: NextRequest) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const retryAfter = checkLoginRate(ip);
  if (retryAfter !== null) {
    return NextResponse.json(
      { error: "too_many_attempts", message: "Too many login attempts. Please try again later." },
      { status: 429, headers: { ...cors(request), "Retry-After": String(retryAfter) } }
    );
  }

  let body: { email?: string; password?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "invalid_request", message: "Something went wrong. Please try again." },
      { status: 400, headers: cors(request) }
    );
  }

  const { email, password } = body;
  if (!email || !password) {
    return NextResponse.json(
      { error: "missing_credentials", message: "Please enter your email and password." },
      { status: 400, headers: cors(request) }
    );
  }

  // Authenticate via Supabase
  const { data: authData, error: authError } =
    await supabase.auth.signInWithPassword({ email, password });

  if (authError || !authData.session) {
    return NextResponse.json(
      { error: "invalid_credentials", message: "Invalid email or password. Please try again." },
      { status: 401, headers: cors(request) }
    );
  }

  const user = authData.user;
  const session = authData.session;

  // Check paid subscription using the user's own JWT so RLS allows the read
  const userClient = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_ANON_KEY!,
    {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: `Bearer ${session.access_token}` } },
    }
  );
  const { data: profile, error: profileError } = await userClient
    .from("user_profiles")
    .select("tier")
    .eq("user_id", user.id)
    .maybeSingle();

  if (profileError) {
    return NextResponse.json(
      { error: "profile_error", message: "Something went wrong loading your account. Please try again." },
      { status: 500, headers: cors(request) }
    );
  }

  if (!profile) {
    return NextResponse.json(
      { error: "User profile not found. Please contact support." },
      { status: 403, headers: cors(request) }
    );
  }

  const isPro = profile.tier && profile.tier.toLowerCase() !== "free";
  if (!isPro) {
    return NextResponse.json(
      {
        error: "subscription_required",
        message: "Upgrade to Pro to use the Vaulty extension.",
        upgradeUrl: "https://vaulty.ca/plans",
      },
      { status: 403, headers: cors(request) }
    );
  }

  return NextResponse.json(
    {
      accessToken: session.access_token,
      refreshToken: session.refresh_token,
      expiresAt: session.expires_at,
      user: { id: user.id, email: user.email },
      isPro: true,
    },
    { headers: cors(request) }
  );
}
