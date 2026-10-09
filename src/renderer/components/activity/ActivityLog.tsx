import type { LogLine } from "../../lib/log";

const TONE_CLASS = {
  info: "text-muted-foreground",
  success: "text-success-foreground",
  error: "text-destructive-foreground",
} as const;

/** 底部状态栏：显示最近几条操作进度和结果 */
export function ActivityLog({
  lines,
  busy,
}: {
  lines: LogLine[];
  busy: boolean;
}) {
  const latest = lines.slice(-3);
  return (
    <section
      aria-live="polite"
      className="flex min-h-[64px] flex-col justify-center gap-1 border-t border-border px-10 py-3 text-[11px]"
    >
      {latest.length === 0 && !busy ? (
        <p className="text-muted-foreground">状态：就绪</p>
      ) : (
        latest.map((line) => (
          <p
            key={line.id}
            className={`whitespace-pre-wrap ${TONE_CLASS[line.tone]}`}
          >
            {line.text}
          </p>
        ))
      )}
      {busy && <p className="text-muted-foreground">处理中…</p>}
    </section>
  );
}
