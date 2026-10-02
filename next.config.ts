import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  /**
   * Argon2 and pg are native/CJS modules. Bundling them into the server build
   * breaks the `.node` binary lookup at runtime, so they stay external and are
   * required from node_modules as normal.
   */
  serverExternalPackages: ['@node-rs/argon2', '@prisma/adapter-pg', 'pg'],

  /**
   * The Supabase root certificate is read at runtime by a path in
   * DATABASE_SSL_CA. Next traces imports, not `readFileSync` on a string from
   * the environment, so the file has to be named explicitly or it is left out
   * of the serverless bundle.
   */
  outputFileTracingIncludes: {
    '/**': ['./certs/**'],
  },

  /**
   * Attachments are uploaded through a server action, which Next caps at 1 MB
   * by default — a scanned bill of lading is often more. Vercel's own ceiling
   * is 4.5 MB a request; the form keeps files to ATTACHMENT_MAX_BYTES (4 MB)
   * so the multipart wrapping always fits.
   */
  experimental: {
    serverActions: {
      bodySizeLimit: '4.5mb',
    },
  },

  /**
   * No other site may show these pages inside a frame of its own — the trick
   * that lays an invisible ERP over a harmless-looking button (clickjacking).
   * Nothing here frames itself, so same-origin framing is all that is kept.
   */
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'self'" },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
};

export default nextConfig;
