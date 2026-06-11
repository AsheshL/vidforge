import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  env: {
    API_GATEWAY_URL: process.env.API_GATEWAY_URL ?? "http://127.0.0.1:4000",
  },
};

export default nextConfig;
