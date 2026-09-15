import type { NextConfig } from "next";
import path from "node:path";
/**
 * NEXT_BUILD_MODE=desktop  →  static export for Electron (FloDesktop)
 * NEXT_BUILD_MODE unset    →  standard Next.js server mode (FloPOS cloud)
 */
const isDesktop = process.env.NEXT_BUILD_MODE === "desktop";

const nextConfig: NextConfig = {
  // Static export: required for Electron — served via embedded Express,
  // not file:// so no CORS/routing issues.
  output: isDesktop ? "export" : undefined,

  // Trailing slashes make static paths predictable: /pos → /pos/index.html
  trailingSlash: isDesktop,

  // next/image optimisation requires a running server; disable for static export.
  images: {
    unoptimized: isDesktop,
  },

  // En el navegador (`npm run dev:frontend`) el frontend vive en :3000 y el
  // backend en :3001, pero la app pide siempre a `origin + /api`. Sin este
  // puente cada llamada cae en Next, que no la sirve. La exportación estática
  // de Electron no lo necesita —allí un solo Express sirve las dos cosas— y
  // además `output: "export"` no admite rewrites.
  ...(isDesktop ? {} : {
    async rewrites() {
      const apiPort = process.env.FLO_API_PORT || '3001';
      return [{ source: '/api/:path*', destination: `http://localhost:${apiPort}/api/:path*` }];
    },
  }),

  // Silence the "multiple lockfiles / inferred workspace root" warning.
  // Allow imports from /main (countries derivation shared with backend) via alias;
  // root must encompass both frontend/ and main/, so it points at the repo root.
  turbopack: {
    root: path.resolve(process.cwd(), '..'),
    resolveAlias: {
      '@countries': '../main/countries.ts',
    },
  },
};

export default nextConfig;
