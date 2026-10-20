import type { NextConfig } from "next";
const config: NextConfig = {
  transpilePackages: ["@agent-city/core"],
  poweredByHeader: false,
};
export default config;
