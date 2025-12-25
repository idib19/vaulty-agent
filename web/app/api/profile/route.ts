import { NextRequest, NextResponse } from "next/server";
import { corsHeaders } from "@/lib/cors";
import type { UserProfile } from "@/lib/profile";

// In-memory store for MVP. In production, use a database.
const profileStore = new Map<string, UserProfile>();

export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders });
}

// GET /api/profile?userId=xxx
export async function GET(request: NextRequest) {
  const userId = request.nextUrl.searchParams.get("userId");
  
  if (!userId) {
    return NextResponse.json(
      { error: "userId is required" },
      { status: 400, headers: corsHeaders }
    );
  }
  
  const profile = profileStore.get(userId);
  
  if (!profile) {
    return NextResponse.json(
      { error: "Profile not found", profile: null },
      { status: 404, headers: corsHeaders }
    );
  }
  
  return NextResponse.json({ profile }, { headers: corsHeaders });
}

// POST /api/profile
export async function POST(request: NextRequest) {
  const body = await request.json();
  const { userId, profile } = body;
  
  if (!userId) {
    return NextResponse.json(
      { error: "userId is required" },
      { status: 400, headers: corsHeaders }
    );
  }
  
  if (!profile) {
    return NextResponse.json(
      { error: "profile is required" },
      { status: 400, headers: corsHeaders }
    );
  }
  
  // Add timestamp
  const profileWithMeta: UserProfile = {
    ...profile,
    updatedAt: new Date().toISOString(),
  };
  
  profileStore.set(userId, profileWithMeta);
  
  return NextResponse.json(
    { ok: true, profile: profileWithMeta },
    { headers: corsHeaders }
  );
}

// DELETE /api/profile?userId=xxx
export async function DELETE(request: NextRequest) {
  const userId = request.nextUrl.searchParams.get("userId");
  
  if (!userId) {
    return NextResponse.json(
      { error: "userId is required" },
      { status: 400, headers: corsHeaders }
    );
  }
  
  profileStore.delete(userId);
  
  return NextResponse.json({ ok: true }, { headers: corsHeaders });
}

