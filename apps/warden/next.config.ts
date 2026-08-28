import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* Standalone output keeps the deployed bundle small — it traces only
   * the files actually imported instead of shipping node_modules to a
   * box with ~120GB of disk. */
  output: "standalone",
  /* The floating dev badge overlaps the escalation ladder. */
  devIndicators: false,
};

export default nextConfig;
