import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import { cors } from "@/lib/cors";

export interface AuthUser {
  userId: string;
  email: string;
  token: string;
}

/**
 * Validates the Bearer token from the Authorization header.
 * Checks that the user has a paid tier in user_profiles.
 *
 * Returns the authenticated user, or a NextResponse error to return immediately.
 */
export async function verifyExtensionAuth(
  request: Request
): Promise<AuthUser | NextResponse> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json(
      { error: "auth_required", message: "Please sign in to continue." },
      { status: 401, headers: cors(request) }
    );
  }

  const token = authHeader.slice(7);

  // Validate JWT with Supabase
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) {
    return NextResponse.json(
      { error: "token_expired", message: "Your session has expired. Please sign in again." },
      { status: 401, headers: cors(request) }
    );
  }

  const user = data.user;

  // Check paid subscription via user_profiles.tier.
  // Use a scoped client with the user's own JWT so RLS lets them read their row.
  const userClient = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_ANON_KEY!,
    {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
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
      { error: "profile_not_found", message: "No account found. Please sign up at vaulty.ca first." },
      { status: 403, headers: cors(request) }
    );
  }

  const isPaid = profile.tier && profile.tier.toLowerCase() !== "free";
  if (!isPaid) {
    return NextResponse.json(
      {
        error: "subscription_required",
        message: "Upgrade to Pro to use the Vaulty extension.",
        upgradeUrl: "https://vaulty.ca/plans",
      },
      { status: 403, headers: cors(request) }
    );
  }

  return { userId: user.id, email: user.email ?? "", token };
}

/** Type guard: check if verifyExtensionAuth returned an error response */
export function isAuthError(
  result: AuthUser | NextResponse
): result is NextResponse {
  return result instanceof NextResponse;
}
