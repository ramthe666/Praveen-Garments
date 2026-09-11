import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  /*
   * The runtime sandbox has ~4 GB RAM. Turbopack's dev cache grows
   * unbounded by default and previously triggered the kernel OOM killer
   * (killing next-server mid-test). This cap makes Turbopack evict
   * least-recently-used cache entries to stay within the limit.
   */
  turbopack: {
    memoryLimit: 1024, // MB
  },
  /*
   * The hosting preview proxy redirects /dashboard -> /dashboard/ (it ADDS a
   * trailing slash). Next.js by default answers /dashboard/ with a 308 to
   * /dashboard (it REMOVES the slash) — proxy and app then bounce the request
   * between each other forever (ERR_TOO_MANY_REDIRECTS).
   *
   * skipTrailingSlashRedirect disables Next's automatic slash-stripping
   * redirect, so BOTH /dashboard and /dashboard/ are served directly and the
   * loop is impossible. The middleware normalises paths so route protection
   * behaves identically for both URL forms.
   */
  skipTrailingSlashRedirect: true,
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

export default nextConfig;
