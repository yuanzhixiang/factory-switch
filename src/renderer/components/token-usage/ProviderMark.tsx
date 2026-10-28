// 提供方徽标。T3 Code 用各家品牌图标（ProviderInstanceIcon），这里用提供方配色的字母徽标代替。
import type { UsageProviderKind } from "../../../shared/token-usage";
import { PROVIDER_PRESENTATION } from "../../lib/token-usage/providers";
import { cn } from "./ui";

export function ProviderMark({
  provider,
  className = "size-4",
}: {
  provider: UsageProviderKind;
  className?: string;
}) {
  const presentation = PROVIDER_PRESENTATION[provider];
  return (
    <span
      aria-hidden
      title={presentation.label}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-[3px] text-[9px] leading-none font-semibold text-background",
        className,
      )}
      style={{ backgroundColor: presentation.color }}
    >
      {presentation.mark}
    </span>
  );
}
