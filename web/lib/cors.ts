const ALLOWED_ORIGINS = [
  "https://agent.vaulty.ca",
  "https://vaulty.ca",
  "http://localhost:3000",
  "http://localhost:3001",
  "http://localhost:5173",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:5173",
];

/**
 * Build CORS headers from a Request (or raw origin string).
 * Chrome extensions send origin "chrome-extension://<id>" which we also allow
 * since they already authenticate via Bearer token.
 */
export function cors(requestOrOrigin?: Request | string | null): Record<string, string> {
  const origin =
    requestOrOrigin instanceof Request
      ? requestOrOrigin.headers.get("Origin")
      : requestOrOrigin ?? null;

  const isAllowed =
    !origin ||
    ALLOWED_ORIGINS.includes(origin) ||
    origin.startsWith("chrome-extension://");

  return {
    "Access-Control-Allow-Origin": isAllowed && origin ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Vary": "Origin",
  };
}

