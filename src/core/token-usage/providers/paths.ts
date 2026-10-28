import path from "node:path";

/** 展开 ~ 开头的路径，移植自 T3 Code（MIT）packages/provider-core/src/server/pathExpansion.ts */
export function expandHomePath(value: string, home: string): string {
  if (!value) return value;
  if (value === "~") return home;
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(home, value.slice(2));
  }
  return value;
}
