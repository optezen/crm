import type { NextConfig } from 'next';
// pdfkit reads its own files at runtime, so it is loaded from node_modules instead of being bundled; the invoice PDF route also needs the bundled fonts in the standalone output.
// Security headers for every response. The CSP is deliberately limited to directives that cannot break hydration or inline styles (no script-src): it forbids framing (clickjacking), <base> and plugin injection, and cross-origin form posts.
// Camera, location and the rest are off; the microphone is allowed for this origin only because voice input uses it. HSTS is set by the host for HTTPS domains.
const securityHeaders = [
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'" },
  { key: 'X-Frame-Options', value: 'DENY' }, { key: 'X-Content-Type-Options', value: 'nosniff' }, { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), geolocation=(), payment=(), microphone=(self)' },
];
const nextConfig: NextConfig = { async headers() { return [{ source: '/:path*', headers: securityHeaders }]; }, output: 'standalone', serverExternalPackages: ['pdfkit'], outputFileTracingIncludes: { '/api/billing/invoices/[id]/pdf': ['./assets/fonts/**'] } };
export default nextConfig;
