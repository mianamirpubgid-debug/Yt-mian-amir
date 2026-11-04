import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // @sparticuz/chromium ko bundle NA hone do — bin folder (chromium binary) node_modules se hi load hota hai
  serverExternalPackages: ["@sparticuz/chromium"],
  // Chromium binary ko function bundle mein force-include karo (Vercel includeFiles ignore karta hai)
  outputFileTracingIncludes: {
    "/api/**": ["./node_modules/@sparticuz/chromium/bin/**"],
  },
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

export default nextConfig;
