import { NextRequest, NextResponse } from "next/server";
import { cors } from "@/lib/cors";
import { verifyExtensionAuth, isAuthError } from "@/lib/auth";

export async function OPTIONS(request: NextRequest) {
  return NextResponse.json({}, { headers: cors(request) });
}

export async function POST(request: NextRequest) {
  const auth = await verifyExtensionAuth(request);
  if (isAuthError(auth)) return auth;

  return NextResponse.json({ ok: true }, { headers: cors(request) });
}

