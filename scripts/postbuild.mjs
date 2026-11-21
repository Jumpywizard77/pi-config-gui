// Post-build steps that tsc/vite cannot do themselves. Run last in the
// `build` script: `tsc -p tsconfig.build.json && vite build && node scripts/postbuild.mjs`.
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Repo root, so the script works from any cwd.
const root = fileURLToPath(new URL("..", import.meta.url));

// 1. Vendored schema: dist/core/schema.js reads ./schema-bundled.json relative
//    to import.meta.url at runtime, but tsc does not copy JSON files.
const bundledSchema = join(root, "src", "core", "schema-bundled.json");
mkdirSync(join(root, "dist", "core"), { recursive: true });
copyFileSync(bundledSchema, join(root, "dist", "core", "schema-bundled.json"));

// 2. Shebang: tsc preserves the one in src/cli.ts, but the `bin` entry is
//    unusable without it, so enforce it instead of trusting the compiler.
//    Guarded for the same reason as step 1: src/cli.ts only lands in Task 8,
//    so dist/cli.js is absent during the scaffold.
const cliPath = join(root, "dist", "cli.js");
if (existsSync(cliPath)) {
  const cliText = readFileSync(cliPath, "utf8");
  if (!cliText.startsWith("#!")) {
    writeFileSync(cliPath, "#!/usr/bin/env node\n" + cliText);
  }

  // 3. Exec bit for the bin entry on POSIX installs (npm respects the mode when
  //    packing). On Windows chmod carries no exec semantics and may throw EPERM
  //    on some filesystems — a warning-free no-op there is fine.
  try {
    chmodSync(cliPath, 0o755);
  } catch {
    // no-op platforms: nothing to do
  }
}
