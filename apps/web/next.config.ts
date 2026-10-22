import type { NextConfig } from 'next';
const config: NextConfig = {
  output: 'standalone',
  ...(process.env.NEXT_TEST_OUTPUT === 'true'
    ? { distDir: '.next-test', typescript: { tsconfigPath: 'tsconfig.browser-tests.json' } }
    : {}),
  logging: { incomingRequests: false, browserToTerminal: false },
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${process.env.API_URL ?? 'http://127.0.0.1:4000'}/api/:path*`,
      },
    ];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};
export default config;
