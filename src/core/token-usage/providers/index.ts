import type { ProviderUsageReader } from "../types";
import { claudeUsageReader } from "./claude";
import { codexUsageReader } from "./codex";
import { grokUsageReader } from "./grok";
import { museUsageReader } from "./muse";
import { piUsageReader } from "./pi";

/** 内置的用量读取器，顺序和 T3 一致，决定去重时谁的记录优先；OpenCode、Antigravity、Cursor 在第 2 批加入 */
export const BUILT_IN_USAGE_READERS: readonly ProviderUsageReader[] = [
  claudeUsageReader,
  codexUsageReader,
  grokUsageReader,
  piUsageReader,
  museUsageReader,
];
