import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: false,
  devIndicators: false,
  // pdfjs-dist and @huggingface/transformers do internal dynamic
  // require()/import() of worker/native-binding files at paths relative to
  // their own package layout. Bundling them breaks those lookups (e.g.
  // pdfjs-dist's Node "fake worker" setup fails to resolve pdf.worker.mjs
  // inside a Turbopack chunk). Keeping them external lets Node's native
  // module resolution load them straight from node_modules instead.
  serverExternalPackages: [
    "pdfjs-dist",
    "@huggingface/transformers",
    "@napi-rs/canvas",
    "better-sqlite3",
    "sqlite-vec",
  ],
};

export default nextConfig;
