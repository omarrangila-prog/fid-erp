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
};

export default nextConfig;
