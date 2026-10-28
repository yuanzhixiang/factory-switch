import { build } from "esbuild";

// 主进程和 preload 都打成 CommonJS：沙箱模式下的 preload 只能是 CJS
const shared = {
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  external: ["electron"],
  sourcemap: true,
  logLevel: "info",
};

await build({
  ...shared,
  // Claude Agent SDK 用 createRequire(import.meta.url)，打成 CJS 后 import.meta 为空，换成当前文件的 URL
  define: { "import.meta.url": "__import_meta_url" },
  banner: { js: 'const __import_meta_url = require("node:url").pathToFileURL(__filename).href;' },
  entryPoints: ["src/main/index.ts"],
  outfile: "out/main/index.cjs",
});

await build({
  ...shared,
  entryPoints: ["src/preload/index.ts"],
  outfile: "out/preload/index.cjs",
});
