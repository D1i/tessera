// Copies the wasm-pack output next to the viewer's static files so the page can
// load it at runtime (and fall back to the TypeScript runtime when it is absent).
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const src = join("crates", "tessera-runtime", "pkg");
const dst = join("apps", "viewer", "public", "wasm");
mkdirSync(dst, { recursive: true });
for (const f of ["tessera_runtime.js", "tessera_runtime_bg.wasm"]) {
  const from = join(src, f);
  if (!existsSync(from)) {
    console.error(`missing ${from}; run wasm-pack first`);
    process.exit(1);
  }
  copyFileSync(from, join(dst, f));
  console.log(`copied ${f}`);
}
