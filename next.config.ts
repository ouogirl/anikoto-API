import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // Pin the workspace root so `next dev` stops complaining about lockfiles that
  // live outside the project (e.g. C:\Users\<you>\package-lock.json on Windows).
  turbopack: {
    root: path.resolve(__dirname),
  },
};

export default nextConfig;
