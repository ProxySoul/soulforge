#!/usr/bin/env bun
/**
 * Build script that uses Bun.build() JS API to enable the React Compiler
 * plugin during production builds. The CLI `bun build` does NOT support
 * plugins — only the JS API does.
 *
 * For --compile builds, this runs two phases:
 *   1. Bun.build() with React Compiler plugin → .build-tmp/soulforge.js
 *   2. Bun.build() compile on the pre-built JS → native binary
 * This works around Bun.build()'s compile mode ignoring the outfile option
 * and not supporting plugins.
 *
 * Usage:
 *   bun scripts/build.ts                                          — build to dist/
 *   bun scripts/build.ts --compile                                — build standalone binary
 *   bun scripts/build.ts --compile --outfile=path --target=bun-darwin-aarch64
 */
import { type BunPlugin } from "bun";
import { renameSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";

// ── Stub plugin for react-devtools-core (optional peer dep of @opentui/react) ──
// In compiled binaries there's no node_modules, so we replace the import with a no-op.
const devtoolsStubPlugin: BunPlugin = {
  name: "devtools-stub",
  setup(build) {
    build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
      path: "react-devtools-core",
      namespace: "devtools-stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "devtools-stub" }, () => ({
      contents: "export default { connectToDevTools() {} };",
      loader: "js",
    }));
  },
};

// ── React Compiler Plugin ────────────────────────────────────────────
const reactCompilerPlugin: BunPlugin = {
  name: "react-compiler",
  setup(build) {
    build.onLoad({ filter: /src\/.*\.tsx?$/ }, async ({ path, loader }) => {
      const { transformSync } = await import("@babel/core");
      const source = await Bun.file(path).text();
      const result = transformSync(source, {
        filename: path,
        plugins: [["babel-plugin-react-compiler", { target: "19" }]],
        parserOpts: { plugins: ["typescript", "jsx"] },
      });
      return { contents: result?.code ?? source, loader };
    });
  },
};

// ── Parse args ───────────────────────────────────────────────────────
const isCompile = process.argv.includes("--compile");

const getFlag = (name: string) => {
  const prefix = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg?.slice(prefix.length);
};

const outfile = getFlag("outfile");
const compileTarget = getFlag("target");

// ── Build ────────────────────────────────────────────────────────────
const start = performance.now();

if (isCompile) {
  const tmpDir = ".build-tmp";

  // Phase 1: Build with React Compiler plugin → .build-tmp/soulforge.js
  // Using "soulforge" as the naming so Bun's compile derives "soulforge" as the binary name.
  const phase1 = await Bun.build({
    entrypoints: ["src/boot.tsx"],
    outdir: tmpDir,
    target: "bun",
    external: ["react-devtools-core"],
    naming: "soulforge.[ext]",
    plugins: [reactCompilerPlugin],
  });

  if (!phase1.success) {
    console.error("Phase 1 (React Compiler) failed:");
    for (const log of phase1.logs) console.error(log);
    process.exit(1);
  }

  // Phase 2: Compile the pre-built JS into a native binary.
  // Bun.build() compile mode ignores outfile — it derives the binary name from
  // the entrypoint basename ("soulforge.js" → "./soulforge") and places it in cwd.
  const phase2 = await Bun.build({
    entrypoints: [`${tmpDir}/soulforge.js`],
    target: "bun",
    plugins: [devtoolsStubPlugin],
    compile: (compileTarget ?? true) as true,
  });

  if (!phase2.success) {
    console.error("Phase 2 (compile) failed:");
    for (const log of phase2.logs) console.error(log);
    process.exit(1);
  }

  rmSync(tmpDir, { recursive: true, force: true });

  // Binary lands at ./soulforge in cwd — move to outfile if specified
  const defaultBinary = resolve("soulforge");
  if (outfile) {
    const dest = resolve(outfile);
    mkdirSync(dirname(dest), { recursive: true });
    renameSync(defaultBinary, dest);
  }

  const elapsed = (performance.now() - start).toFixed(0);
  const finalPath = outfile ? resolve(outfile) : defaultBinary;
  console.log(`✓ Compiled binary with React Compiler in ${elapsed}ms → ${finalPath}`);
} else {
  const result = await Bun.build({
    entrypoints: ["src/boot.tsx"],
    outdir: "dist",
    target: "bun",
    external: ["react-devtools-core"],
    naming: "[dir]/index.[ext]",
    plugins: [reactCompilerPlugin],
  });

  if (!result.success) {
    console.error("Build failed:");
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }

  const elapsed = (performance.now() - start).toFixed(0);
  const count = result.outputs.length;
  console.log(
    `✓ Built ${count} artifact${count === 1 ? "" : "s"} with React Compiler in ${elapsed}ms`,
  );
}
