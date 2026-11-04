/** Hosted mode: data lives in Blob, private addresses are blocked and requests are rate limited. */
export const DEMO_MODE = process.env.NEXT_PUBLIC_DEMO_MODE === "1";

/** Off by default. Set to "1" with ACCESS_PASSWORD to require a password for compile and chat. */
export const PASSWORD_REQUIRED = DEMO_MODE && process.env.NEXT_PUBLIC_REQUIRE_PASSWORD === "1";
