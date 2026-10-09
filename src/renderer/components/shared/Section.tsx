import type { ReactNode } from "react";

/** 详情页里的一个区块：12px 标题 + 内容，区块之间靠大留白分隔，和 Factory 设置页一致 */
export function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-4">
      <div className="flex h-6 items-center justify-between">
        <h3 className="text-xs">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}
