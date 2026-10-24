// Security headers for pages, applied per request by proxy.ts.

export type CspOptions = {
  nonce: string;
  // `next dev` needs eval for React's debugging features.
  dev: boolean;
  // True when the site is served over HTTPS (production behind TLS).
  https: boolean;
};

export function contentSecurityPolicy({ nonce, dev, https }: CspOptions): string {
  const directives = [
    "default-src 'self'",
    // Only scripts carrying this request's nonce may run. 'strict-dynamic'
    // lets those scripts load Next's chunks without listing each file.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    // Components set data-driven inline styles (brand colours, bar widths),
    // which nonces cannot cover. Styles cannot run code.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];
  if (https) directives.push('upgrade-insecure-requests');
  return directives.join('; ');
}

// Two years, the value HSTS preload lists expect. Sent only over HTTPS.
export const STRICT_TRANSPORT_SECURITY = 'max-age=63072000; includeSubDomains';

export function servedOverHttps(appOrigin: string | undefined, nodeEnv: string | undefined) {
  return nodeEnv === 'production' && Boolean(appOrigin?.startsWith('https://'));
}
