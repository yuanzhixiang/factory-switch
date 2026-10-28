// 价格与模型映射的保存目标和写入，移植自 T3 Code（MIT）apps/web/src/components/usage/usagePriceTargets.ts
// 本应用只有本机一个目标；写入用补丁形式，null 表示删除该模型的自定义价格或映射。
import type {
  TokenUsageSettingsPatch,
  UsageModelPriceOverride,
} from "../../../shared/token-usage";
import type { EnvironmentId } from "./merge";

export interface UsagePriceTarget {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly prices: Readonly<Record<string, UsageModelPriceOverride>> | null;
  readonly aliases: Readonly<Record<string, string>> | null;
  readonly unavailable: string | null;
}

/** null 表示删除该模型的自定义价格或映射 */
export type UsagePriceChange =
  | { readonly model: string; readonly price: UsageModelPriceOverride | null }
  | { readonly model: string; readonly alias: string | null };

/** 与主进程的设置补丁格式相同：按条目合并，null 表示删除 */
export type UsagePricePatch = TokenUsageSettingsPatch;

export type UsagePriceWriteResult =
  | { readonly status: "saved" }
  | { readonly status: "failed"; readonly error: string };

/** 每个目标各自保存、互不影响；重试时只传失败的目标 */
export async function writeUsagePrices(input: {
  readonly targets: readonly UsagePriceTarget[];
  readonly changes: ReadonlyMap<EnvironmentId, readonly UsagePriceChange[]>;
  readonly write: (input: {
    environmentId: EnvironmentId;
    input: { patch: UsagePricePatch };
  }) => Promise<{ readonly _tag: "Success" | "Failure" }>;
  readonly onResult: (environmentId: EnvironmentId, result: UsagePriceWriteResult) => void;
}) {
  await Promise.all(
    input.targets.map(async (target) => {
      let result: UsagePriceWriteResult;
      const changes = input.changes.get(target.environmentId) ?? [];
      const prices = changes.flatMap((change) =>
        "price" in change ? [[change.model, change.price] as const] : [],
      );
      const aliases = changes.flatMap((change) =>
        "alias" in change ? [[change.model, change.alias] as const] : [],
      );
      if (target.unavailable !== null) {
        result = { status: "failed", error: target.unavailable };
      } else if (aliases.length > 0 && target.aliases === null) {
        result = { status: "failed", error: "当前版本不支持模型映射" };
      } else {
        try {
          const saved =
            changes.length === 0
              ? { _tag: "Success" as const }
              : await input.write({
                  environmentId: target.environmentId,
                  input: {
                    patch: {
                      ...(prices.length > 0
                        ? { usagePriceOverrides: Object.fromEntries(prices) }
                        : {}),
                      ...(aliases.length > 0
                        ? { usageModelAliases: Object.fromEntries(aliases) }
                        : {}),
                    },
                  },
                });
          result =
            saved._tag === "Success"
              ? { status: "saved" }
              : { status: "failed", error: "保存失败，请重试。" };
        } catch {
          result = { status: "failed", error: "保存失败，请重试。" };
        }
      }
      input.onResult(target.environmentId, result);
    }),
  );
}
