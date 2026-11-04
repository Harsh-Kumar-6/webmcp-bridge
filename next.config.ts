import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  // Lets a test server run beside the normal dev server.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  serverExternalPackages: ["playwright", "playwright-core", "@sparticuz/chromium"],
  outputFileTracingIncludes: {
    "/api/**": [
      "./demo-data/**/*",
      "./node_modules/@sparticuz/chromium/**/*",
      "./node_modules/playwright/**/*",
      "./node_modules/playwright-core/**/*",
    ],
  },
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
