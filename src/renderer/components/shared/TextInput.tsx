import type { InputHTMLAttributes } from "react";

/** Factory 风格的输入框：细边框、2px 圆角、聚焦时橙色边 */
export function TextInput({
  className = "",
  ...props
}: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`h-8 rounded-[2px] border border-border-strong bg-background px-3 text-xs outline-none placeholder:text-muted-foreground focus:border-primary ${className}`}
      {...props}
    />
  );
}
