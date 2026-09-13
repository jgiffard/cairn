import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // Standalone output keeps the runtime image small; see Dockerfile.
  output: 'standalone',
  reactStrictMode: true,
  poweredByHeader: false,
  // AGENTS.md is hand-written, read by every agent at session start, and held
  // under 8KB by CI. `next dev` appends a 679-byte block to it on every start,
  // so the file arrives over budget and the failure lands on whichever PR is
  // unlucky enough to be next — for a reason that appears nowhere in its diff.
  agentRules: false,
}

export default nextConfig
