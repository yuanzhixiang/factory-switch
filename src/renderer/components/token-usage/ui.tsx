// token 统计页用到的小组件：下拉菜单、分段切换、宽弹窗、骨架屏、提示气泡和图标。
// T3 Code 用的是 Base UI 组件库，这里用原生元素和 Tailwind 实现等价的交互，视觉沿用本项目的 token。
import {
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
  type SVGProps,
} from "react";

/** 拼接 className，忽略假值 */
export function cn(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(" ");
}

function Icon({ children, className = "size-3.5", ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={className}
      {...props}
    >
      {children}
    </svg>
  );
}

export const ChevronDownIcon = (props: SVGProps<SVGSVGElement>) => (
  <Icon {...props}>
    <path d="m6 9 6 6 6-6" />
  </Icon>
);

export const RefreshIcon = ({
  refreshing,
  ...props
}: SVGProps<SVGSVGElement> & { refreshing?: boolean }) => (
  <Icon {...props} className={cn(props.className ?? "size-3.5", refreshing && "animate-spin")}>
    <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
    <path d="M21 3v5h-5" />
    <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
    <path d="M8 16H3v5" />
  </Icon>
);

export const InfoIcon = (props: SVGProps<SVGSVGElement>) => (
  <Icon {...props}>
    <circle cx="12" cy="12" r="10" />
    <path d="M12 16v-4" />
    <path d="M12 8h.01" />
  </Icon>
);

export const AlertIcon = (props: SVGProps<SVGSVGElement>) => (
  <Icon {...props}>
    <circle cx="12" cy="12" r="10" />
    <path d="M12 8v4" />
    <path d="M12 16h.01" />
  </Icon>
);

export const SlidersIcon = (props: SVGProps<SVGSVGElement>) => (
  <Icon {...props}>
    <path d="M10 5H3" />
    <path d="M12 19H3" />
    <path d="M14 3v4" />
    <path d="M16 17v4" />
    <path d="M21 12h-9" />
    <path d="M21 19h-5" />
    <path d="M21 5h-7" />
    <path d="M8 10v4" />
    <path d="M8 12H3" />
  </Icon>
);

export const PlusIcon = (props: SVGProps<SVGSVGElement>) => (
  <Icon {...props}>
    <path d="M5 12h14" />
    <path d="M12 5v14" />
  </Icon>
);

export const ResetIcon = (props: SVGProps<SVGSVGElement>) => (
  <Icon {...props}>
    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
    <path d="M3 3v5h5" />
  </Icon>
);

export const CloseIcon = (props: SVGProps<SVGSVGElement>) => (
  <Icon {...props}>
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </Icon>
);

const CheckIcon = (props: SVGProps<SVGSVGElement>) => (
  <Icon {...props}>
    <path d="M20 6 9 17l-5-5" />
  </Icon>
);

/** 无边框的行内按钮，用在面包屑和提示图标上 */
export function InlineButton({ className, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex items-center gap-1 rounded-[2px] text-left outline-none focus-visible:outline-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-40",
        className,
      )}
      {...props}
    />
  );
}

/** 只有图标的方形按钮 */
export function IconButton({ className, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex size-6 shrink-0 items-center justify-center rounded-[2px] text-secondary-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-40",
        className,
      )}
      {...props}
    />
  );
}

/** 点击触发器展开的下拉菜单；点外面或按 Esc 收起 */
export function Dropdown({
  trigger,
  children,
  align = "start",
  className,
  triggerClassName,
  disabled,
  ariaLabel,
}: {
  trigger: (open: boolean) => ReactNode;
  children: ReactNode | ((close: () => void) => ReactNode);
  align?: "start" | "end";
  className?: string;
  triggerClassName?: string;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  const close = () => setOpen(false);
  return (
    <div ref={rootRef} className="relative min-w-0">
      <InlineButton
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
        data-open={open || undefined}
        className={triggerClassName}
        onClick={() => setOpen((previous) => !previous)}
      >
        {trigger(open)}
      </InlineButton>
      {open && (
        <div
          role="menu"
          className={cn(
            "absolute top-full z-30 mt-1 flex max-h-96 min-w-48 flex-col overflow-auto rounded-[2px] border border-border bg-background py-1 text-xs shadow-dialog",
            align === "end" ? "right-0" : "left-0",
            className,
          )}
        >
          {typeof children === "function" ? children(close) : children}
        </div>
      )}
    </div>
  );
}

export function MenuCheckboxItem({
  checked,
  onCheckedChange,
  children,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      onClick={() => onCheckedChange(!checked)}
      className="flex h-7 w-full shrink-0 items-center gap-2 px-2 text-left hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
    >
      <span className="flex size-3.5 shrink-0 items-center justify-center text-primary">
        {checked ? <CheckIcon className="size-3.5" /> : null}
      </span>
      <span className="min-w-0 flex-1">{children}</span>
    </button>
  );
}

export function MenuItem({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="flex h-7 w-full shrink-0 items-center gap-2 px-2 text-left hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
    >
      {children}
    </button>
  );
}

export function MenuSeparator() {
  return <div role="separator" className="my-1 h-px shrink-0 bg-border" />;
}

/** 分段切换，和截图里的时间段、费用/Tokens 选择器一致 */
export function Segmented<T extends string | number>({
  ariaLabel,
  value,
  options,
  onChange,
  disabled,
}: {
  ariaLabel: string;
  value: T;
  options: readonly { value: T; label: string; title?: string }[];
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={cn(
        "flex shrink-0 rounded-[2px] border border-border p-0.5",
        disabled && "opacity-40",
      )}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={String(option.value)}
            type="button"
            aria-pressed={active}
            title={option.title}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            className={cn(
              "h-6 rounded-[2px] px-2.5 text-xs whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-primary disabled:cursor-not-allowed",
              active
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** 宽版模态弹窗（原生 dialog），Esc 关闭 */
export function Dialog({
  title,
  titleAside,
  description,
  children,
  footer,
  onClose,
  className,
}: {
  title: ReactNode;
  titleAside?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  return (
    <dialog
      ref={ref}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        // 点遮罩（dialog 自身而非内容）关闭
        if (event.target === event.currentTarget) onClose();
      }}
      className={cn(
        "m-auto max-h-[calc(100vh-4rem)] w-[calc(100vw-4rem)] rounded-[2px] border border-border bg-background p-0 text-foreground shadow-dialog",
        className,
      )}
    >
      <div className="flex max-h-[calc(100vh-4rem)] flex-col">
        <div className="flex items-start gap-3 border-b border-border px-6 py-4">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex min-w-0 items-center gap-2 text-sm">
              {titleAside}
              <h2 className="min-w-0 truncate">{title}</h2>
            </div>
            {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
          </div>
          <IconButton aria-label="关闭" onClick={onClose}>
            <CloseIcon />
          </IconButton>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-6 py-5">{children}</div>
        {footer ? (
          <div className="flex items-center justify-between gap-3 border-t border-border px-6 py-3">
            {footer}
          </div>
        ) : null}
      </div>
    </dialog>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-[2px] bg-muted", className)} />;
}

/** 悬停或聚焦时显示的小提示气泡 */
export function HoverTip({
  label,
  children,
  tip,
  side = "top",
}: {
  label: string;
  children: ReactNode;
  tip: ReactNode;
  side?: "top" | "bottom";
}) {
  return (
    <span className="group/tip relative inline-flex">
      <InlineButton aria-label={label} className="text-muted-foreground hover:text-foreground">
        {children}
      </InlineButton>
      <span
        role="tooltip"
        className={cn(
          "pointer-events-none absolute left-1/2 z-30 hidden w-max max-w-64 -translate-x-1/2 rounded-[2px] bg-inverse px-2 py-1 text-[11px] text-inverse-foreground group-focus-within/tip:block group-hover/tip:block",
          side === "top" ? "bottom-full mb-1" : "top-full mt-1",
        )}
      >
        {tip}
      </span>
    </span>
  );
}
