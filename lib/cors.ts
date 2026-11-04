/** Compiled tools are meant to be called from other origins, including injected WebMCP scripts. */
export const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, accept, mcp-protocol-version, mcp-session-id",
};

export const preflight = () => new Response(null, { status: 204, headers: CORS_HEADERS });
