// CORS headers for App Router
// Dev-friendly: allow all
// For prod: restrict to your domain + your extension ID origin.
export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

