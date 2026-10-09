import type { LogLine } from "../../lib/log";

/** 底部状态区：显示最近几条操作进度和结果 */
export function ActivityLog({
  lines,
  busy,
}: {
  lines: LogLine[];
  busy: boolean;
}) {
  const latest = lines.slice(-4);
  return (
    <section
      aria-live="polite"
      className="flex min-h-[88px] flex-col gap-1 rounded-lg border border-border bg-card px-4 py-3 text-sm"
    >
      {latest.length === 0 && !busy ? (
        <p className="text-muted-foreground">状态：就绪</p>
      ) : (
        latest.map((line) => (
          <p
            key={line.id}
            className={`whitespace-pre-wrap ${line.tone === "error" ? "text-destructive" : line.tone === "success" ? "text-success" : "text-muted-foreground"}`}
          >
            {line.text}
          </p>
        ))
      )}
      {busy && <p className="text-muted-foreground">处理中…</p>}
    </section>
  );
}
