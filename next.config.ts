import type { NextConfig } from 'next';
// pdfkit reads its own files at runtime, so it is loaded from node_modules instead of being bundled; the invoice PDF route also needs the bundled fonts in the standalone output.
const nextConfig: NextConfig = { output: 'standalone', serverExternalPackages: ['pdfkit'], outputFileTracingIncludes: { '/api/billing/invoices/[id]/pdf': ['./assets/fonts/**'] } };
export default nextConfig;
