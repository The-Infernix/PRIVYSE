import { createRequire } from "node:module";
import * as esbuild from "esbuild";

const require = createRequire(import.meta.url);

await esbuild.build({
  entryPoints: ["src/inpage-entry.ts"],
  bundle: true,
  outfile: "dist/inpage.js",
  format: "iife",
  platform: "browser",
  target: ["chrome115"],
  logLevel: "info",
});

console.log("built dist/inpage.js");