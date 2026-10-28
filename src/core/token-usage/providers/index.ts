import type { ProviderUsageReader } from "../types";
import { antigravityUsageReader } from "./antigravity";
import { claudeUsageReader } from "./claude";
import { codexUsageReader } from "./codex";
import { cursorUsageReader } from "./cursor";
import { grokUsageReader } from "./grok";
import { museUsageReader } from "./muse";
import { openCodeUsageReader } from "./opencode";
import { piUsageReader } from "./pi";

/** 内置的用量读取器，顺序和 T3 一致，决定去重时谁的记录优先 */
export const BUILT_IN_USAGE_READERS: readonly ProviderUsageReader[] = [
  claudeUsageReader,
  codexUsageReader,
  grokUsageReader,
  piUsageReader,
  openCodeUsageReader,
  museUsageReader,
  antigravityUsageReader,
  cursorUsageReader,
];
