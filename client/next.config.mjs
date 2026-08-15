/** @type {import('next').NextConfig} */
const nextConfig = {
  // Proxy /backend/* → backend API — avoids browser cross-origin restrictions
  async rewrites() {
    const apiUrl = process.env.API_URL ?? 'http://localhost:8000';
    return [
      { source: '/backend/:path*', destination: `${apiUrl}/:path*` },
    ];
  },

  // Team crests and competition logos come from API-Football's CDN, on every
  // match row. next/image refuses a remote host that is not listed here.
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'media.api-sports.io' },
    ],
  },
};

export default nextConfig;
