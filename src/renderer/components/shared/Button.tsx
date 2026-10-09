import type { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "secondary" | "danger" | "text";

// 对齐 Factory 设置页：24px 高、4px 12px 内边距、2px 圆角
const VARIANT_CLASSES: Record<Variant, string> = {
  primary:
    "border-primary bg-primary text-primary-foreground hover:border-primary-hover hover:bg-primary-hover",
  secondary:
    "border-border-strong bg-background text-foreground hover:border-foreground",
  danger:
    "border-border-strong bg-background text-destructive-foreground hover:border-destructive",
  text: "border-transparent text-secondary-foreground hover:text-foreground",
};

/** 全局统一的按钮样式 */
export function Button({
  variant = "secondary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      type="button"
      className={`inline-flex h-6 items-center justify-center gap-2 rounded-[2px] border px-3 text-xs whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-40 ${VARIANT_CLASSES[variant]} ${className}`}
      {...props}
    />
  );
}
