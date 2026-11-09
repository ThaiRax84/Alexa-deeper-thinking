// Bundles each Lambda into dist/<name>/ with esbuild. The AWS SDK v3 is provided by
// the Node.js Lambda runtime, so it is left out of the bundles.
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

const common = {
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  minify: true,
  external: ["@aws-sdk/*"],
  logLevel: "warning",
  // CommonJS dependencies inside an ES module bundle need a real `require`.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
};

const functions = {
  skill: { entry: "packages/skill/lambda/index.js", calendar: true },
  worker: { entry: "packages/worker/src/index.js" },
  portal: { entry: "packages/portal/src/index.js", calendar: true, public: "packages/portal/public" },
};

rmSync(dist, { recursive: true, force: true });
for (const [name, fn] of Object.entries(functions)) {
  const out = join(dist, name);
  mkdirSync(out, { recursive: true });
  await build({ ...common, entryPoints: [join(root, fn.entry)], outfile: join(out, "index.mjs") });
  if (fn.calendar) {
    await build({
      ...common,
      entryPoints: [join(root, "packages/calendar-mcp/src/index.js")],
      outfile: join(out, "calendar-server.mjs"),
    });
  }
  if (fn.public) cpSync(join(root, fn.public), join(out, "public"), { recursive: true });
  writeFileSync(join(out, "package.json"), JSON.stringify({ type: "module" }));
  console.log(`built dist/${name}`);
}
