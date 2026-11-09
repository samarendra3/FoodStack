import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  // Trace files from the monorepo root so the standalone build includes workspace packages.
  outputFileTracingRoot: fileURLToPath(new URL('../../', import.meta.url)),
  transpilePackages: ['@foodstack/ui'],
  poweredByHeader: false,
  reactStrictMode: true,
  // Uploaded menu photos are stored by the API; serve them from this origin under /media.
  async rewrites() {
    const api = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1').replace(
      /\/+$/,
      '',
    );
    return [{ source: '/media/:path*', destination: `${api}/media/:path*` }];
  },
};

export default nextConfig;
