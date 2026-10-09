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
  entryPoints: ["src/main/index.ts"],
  outfile: "out/main/index.cjs",
});

await build({
  ...shared,
  entryPoints: ["src/preload/index.ts"],
  outfile: "out/preload/index.cjs",
});
