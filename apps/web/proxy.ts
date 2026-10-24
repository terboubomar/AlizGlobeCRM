import { NextResponse, type NextRequest } from 'next/server';
import {
  STRICT_TRANSPORT_SECURITY,
  contentSecurityPolicy,
  servedOverHttps,
} from './app/security-headers';

// Adds a per-request nonce-based Content-Security-Policy to every page.
// Next.js reads the nonce from the request's CSP header while rendering and
// attaches it to its own scripts, so pages must render dynamically (see
// app/layout.tsx).
export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64');
  const https = servedOverHttps(process.env.APP_ORIGIN, process.env.NODE_ENV);
  const csp = contentSecurityPolicy({
    nonce,
    dev: process.env.NODE_ENV === 'development',
    https,
  });

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  if (https) response.headers.set('Strict-Transport-Security', STRICT_TRANSPORT_SECURITY);
  return response;
}

export const config = {
  matcher: [
    {
      // Pages only: skip the API proxy, build assets and public files.
      source: '/((?!api|_next/static|_next/image|favicon.ico|logos).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
