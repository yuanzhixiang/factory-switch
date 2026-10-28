import type { UsageProviderKind } from "../../src/shared/token-usage";
import type { TranscriptUsageFormat } from "../../src/core/token-usage/types";
import { claudeUsageFormat } from "../../src/core/token-usage/providers/claude";
import { codexUsageFormat } from "../../src/core/token-usage/providers/codex";
import { grokUsageFormat } from "../../src/core/token-usage/providers/grok";
import { museUsageFormat } from "../../src/core/token-usage/providers/muse";
import { piUsageFormat } from "../../src/core/token-usage/providers/pi";

export const TEST_FORMATS: Record<
  "claude" | "codex" | "grok" | "pi" | "muse",
  TranscriptUsageFormat<unknown>
> = {
  claude: claudeUsageFormat as TranscriptUsageFormat<unknown>,
  codex: codexUsageFormat as TranscriptUsageFormat<unknown>,
  grok: grokUsageFormat as TranscriptUsageFormat<unknown>,
  pi: piUsageFormat as TranscriptUsageFormat<unknown>,
  muse: museUsageFormat,
};

export const TEST_FORMAT_MAP = new Map<UsageProviderKind, TranscriptUsageFormat<unknown>>(
  Object.entries(TEST_FORMATS) as Array<[UsageProviderKind, TranscriptUsageFormat<unknown>]>,
);
