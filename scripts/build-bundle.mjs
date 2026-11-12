import { build } from "esbuild";

// One self-contained file for the stdio server: no runtime dependencies, so a
// host can pin the published package by its hash and run it with plain `node`
// without resolving anything from a registry.
await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: "dist/stdio.bundle.mjs",
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  legalComments: "none",
});
