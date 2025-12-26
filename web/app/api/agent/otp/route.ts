import { NextRequest, NextResponse } from "next/server";

/**
 * OTP API Route
 * 
 * Fetches OTP codes from the Vaulty Inbox API for automatic verification.
 * Uses the /api/inbox/artifacts/dev endpoint with admin token.
 * 
 * Required environment variables:
 * - VAULTY_API_URL: The base URL for the Vaulty API (e.g., https://api.vaulty.ca)
 * - VAULTY_API_TOKEN: Admin bearer token for authentication
 * 
 * API Response shape:
 * {
 *   artifact: null | { id, kind, value, confidence, sourceDomain, receivedAt, expiresAt, consumed },
 *   proxyEmail: string,
 *   deprecationWarning?: string
 * }
 * 
 * Common errors:
 * - 401: missing/invalid Authorization header
 * - 400: missing proxy_email or invalid/missing kind
 * - 404: no inbox found for that proxy_email
 */

interface OtpRequest {
  email: string;           // The proxy email (e.g., user@mailbox.vaulty.ca)
  jobId?: string;
  kind?: "otp" | "verify_link";  // Type of artifact to fetch
  consume?: boolean;       // Mark as consumed after fetching
  waitMs?: number;         // Long-poll wait time (max 30000)
}

// Vaulty API artifact structure
interface VaultyArtifact {
  id: string;
  kind: "otp" | "verify_link";
  value: string;           // The OTP code or verify link
  confidence: number;      // Confidence score
  sourceDomain: string;    // Where the email came from
  receivedAt: string;      // ISO timestamp
  expiresAt: string;       // ISO timestamp
  consumed: boolean;       // Whether it's been consumed
}

// Vaulty API response structure
interface VaultyArtifactResponse {
  artifact: VaultyArtifact | null;
  proxyEmail: string;
  deprecationWarning?: string;
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as OtpRequest;
    
    // Validate required fields - must be in format user@mailbox.vaulty.ca
    if (!body.email) {
      return NextResponse.json(
        { ok: false, error: "Email (proxy_email) is required" },
        { status: 400 }
      );
    }

    // Validate email format (should be user@mailbox.vaulty.ca)
    if (!body.email.endsWith("@mailbox.vaulty.ca")) {
      console.warn(`[OTP] Email ${body.email} is not a Vaulty proxy email format`);
      // Don't fail, but warn - the API will handle validation
    }

    // Get environment variables
    const apiUrl = process.env.VAULTY_API_URL;
    const apiToken = process.env.VAULTY_API_TOKEN;

    if (!apiUrl || !apiToken) {
      console.error("[OTP] Missing VAULTY_API_URL or VAULTY_API_TOKEN environment variables");
      return NextResponse.json(
        { ok: false, error: "OTP service not configured" },
        { status: 500 }
      );
    }

    console.log(`[OTP] Fetching artifact for proxy email: ${body.email}`);

    // Build the Vaulty API URL with query parameters
    // Endpoint: GET /api/inbox/artifacts/dev
    const artifactUrl = new URL("/api/inbox/artifacts/dev", apiUrl);
    
    // Required params
    artifactUrl.searchParams.set("proxy_email", body.email);
    artifactUrl.searchParams.set("kind", body.kind || "otp");
    
    // Optional params
    if (body.consume !== false) {
      // Default to consuming the artifact
      artifactUrl.searchParams.set("consume", "true");
    }
    if (body.waitMs) {
      // Long-poll wait time (max 30000ms)
      const waitMs = Math.min(body.waitMs, 30000);
      artifactUrl.searchParams.set("wait_ms", String(waitMs));
    } else {
      // Default to 5 second wait for OTP to arrive
      artifactUrl.searchParams.set("wait_ms", "5000");
    }

    console.log(`[OTP] Calling Vaulty API: GET /api/inbox/artifacts/dev?proxy_email=${body.email}&kind=${body.kind || "otp"}`);

    // Call the Vaulty API
    const response = await fetch(artifactUrl.toString(), {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
    });

    // Handle error responses
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[OTP] Vaulty API error: ${response.status} - ${errorText}`);
      
      // Map common error codes
      let errorMessage = `OTP service error: ${response.status}`;
      if (response.status === 401) {
        errorMessage = "OTP service authentication failed - check VAULTY_API_TOKEN";
      } else if (response.status === 400) {
        errorMessage = "Invalid request - check proxy_email format";
      } else if (response.status === 404) {
        errorMessage = "No inbox found for this email";
      }
      
      return NextResponse.json(
        { ok: false, error: errorMessage, statusCode: response.status },
        { status: response.status }
      );
    }

    const data = (await response.json()) as VaultyArtifactResponse;

    // Log deprecation warning if present
    if (data.deprecationWarning) {
      console.warn(`[OTP] Deprecation warning: ${data.deprecationWarning}`);
    }

    // Check if artifact exists
    if (!data.artifact) {
      console.log("[OTP] No artifact found (null) - OTP may not have arrived yet");
      return NextResponse.json(
        { ok: false, error: "No OTP available yet - try again in a few seconds" },
        { status: 404 }
      );
    }

    const artifact = data.artifact;
    console.log(`[OTP] Retrieved artifact: kind=${artifact.kind}, value=${artifact.value.slice(0, 3)}***, confidence=${artifact.confidence}, sourceDomain=${artifact.sourceDomain}`);

    // Check if already consumed
    if (artifact.consumed) {
      console.warn("[OTP] Artifact was already consumed");
    }

    // Check if expired
    if (artifact.expiresAt && new Date(artifact.expiresAt) < new Date()) {
      console.warn("[OTP] Artifact has expired");
      return NextResponse.json(
        { ok: false, error: "OTP has expired" },
        { status: 410 }  // Gone
      );
    }

    // Return the artifact value based on kind
    if (artifact.kind === "otp") {
      console.log(`[OTP] Successfully retrieved OTP (${artifact.value.length} characters)`);
      return NextResponse.json({
        ok: true,
        code: artifact.value,
        kind: "otp",
        confidence: artifact.confidence,
        sourceDomain: artifact.sourceDomain,
        expiresAt: artifact.expiresAt,
        consumed: artifact.consumed,
      });
    }

    if (artifact.kind === "verify_link") {
      console.log(`[OTP] Successfully retrieved verify link`);
      return NextResponse.json({
        ok: true,
        verifyLink: artifact.value,
        kind: "verify_link",
        confidence: artifact.confidence,
        sourceDomain: artifact.sourceDomain,
        expiresAt: artifact.expiresAt,
        consumed: artifact.consumed,
      });
    }

    return NextResponse.json(
      { ok: false, error: `Unknown artifact kind: ${artifact.kind}` },
      { status: 500 }
    );

  } catch (error) {
    console.error("[OTP] Error fetching artifact:", error);
    return NextResponse.json(
      { ok: false, error: String(error) },
      { status: 500 }
    );
  }
}

