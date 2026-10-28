// 额度池视图：每个提供方一组卡片，每张卡片是一个周期（5 小时 / 每周 / 每月…），
// 卡片里每个账号一段进度条，悬停或点击查看该账号的详情和重置次数。
// 移植自 T3 Code（MIT）apps/web/src/components/usage/UsageLimitsPooled.tsx。
// 改动：T3 用 Base UI 的共享 Popover，这里用 React context + fixed 定位实现「全页共用一个浮层」；
// 外部用量链接用 <a target="_blank"> 打开（T3 走 shell.openExternal）。
import {
  createContext,
  Fragment,
  use,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import {
  CHATGPT_USAGE_URL,
  collectExternalUsageLinks,
  collectLimitAccounts,
  collectLimitNotices,
  collectLimitPools,
  cursorUsageWindowDetails,
  displayLimitWindows,
  formatResetsIn,
  formatUpcomingTimestamp,
  paceRemainingPercent,
  remainingPercent,
  resetsInDuration,
  type LimitAccount,
  type LimitPool,
  type LimitPoolMember,
  type LimitPoolWindow,
  type LimitPresentations,
} from "../../lib/usage-limits/limits";
import { AlertIcon, cn } from "../token-usage/ui";
import {
  barColor,
  driverLabel,
  ExternalLinkIcon,
  PaceIcon,
  ResetCreditDialog,
  resetCreditsSummary,
  TicketIcon,
  usePaceMark,
  useResetCredit,
} from "./UsageLimits";
import { DRIVER_PROVIDER } from "../../lib/usage-limits/store";
import { PROVIDER_PRESENTATION } from "../../lib/token-usage/providers";

function accountInitials(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  return `${local[0] ?? ""}${domain[0] ?? ""}`.toUpperCase() || "?";
}

function accountHue(email: string): number {
  let hash = 0;
  for (let index = 0; index < email.length; index += 1) {
    hash = (hash * 31 + email.charCodeAt(index)) | 0;
  }
  return Math.abs(hash) % 360;
}

function AccountChip({ email }: { readonly email: string }) {
  const hue = accountHue(email);
  return (
    <span
      role="img"
      aria-label={`账号 ${accountInitials(email)}`}
      className="inline-flex size-4 shrink-0 items-center justify-center rounded-full text-[8px] leading-none font-semibold"
      style={{ backgroundColor: `oklch(0.85 0.08 ${hue})`, color: `oklch(0.35 0.1 ${hue})` }}
    >
      {accountInitials(email)}
    </span>
  );
}

/** 提供方的字母徽标，代替 T3 的 ProviderInstanceIcon */
function DriverMark({
  driver,
  className,
}: {
  readonly driver: LimitAccount["driver"];
  readonly className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex size-5 shrink-0 items-center justify-center rounded-[2px] bg-muted text-[9px] leading-none font-semibold text-foreground/80",
        className,
      )}
    >
      {PROVIDER_PRESENTATION[DRIVER_PROVIDER[driver]].mark}
    </span>
  );
}

function AccountAvatar({ account }: { readonly account: LimitAccount }) {
  if (account.redeem) return <DriverMark driver={account.driver} />;
  return account.email ? <AccountChip email={account.email} /> : null;
}

function AccountName({
  account,
  className,
}: {
  readonly account: LimitAccount;
  readonly className?: string;
}) {
  if (account.displayName) return <span className={className}>{account.displayName}</span>;
  if (account.email) {
    return (
      <span className={cn("inline-flex min-w-0 items-center", className)}>
        <AccountChip email={account.email} />
      </span>
    );
  }
  return <span className={className}>{driverLabel(account.driver)}</span>;
}

/** 邮箱默认打码，点一下显示，对应 T3 的 RedactedSensitiveText */
function RedactedEmail({ value }: { readonly value: string }) {
  const [revealed, setRevealed] = useState(false);
  const [local = "", domain = ""] = value.split("@");
  const masked = `${local.slice(0, 1)}•••${domain ? `@${domain}` : ""}`;
  return (
    <button
      type="button"
      aria-label="切换邮箱显示"
      title={revealed ? "点击隐藏邮箱" : "点击显示邮箱"}
      onClick={() => setRevealed((previous) => !previous)}
      className="w-fit truncate text-left text-muted-foreground hover:text-foreground"
    >
      {revealed ? value : masked}
    </button>
  );
}

function Row({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 text-foreground tabular-nums">{children}</span>
    </div>
  );
}

type SegmentPayload = {
  readonly account: LimitAccount;
  readonly window: LimitPoolMember["window"];
  readonly reset: LimitPoolWindow["resets"][number] | undefined;
  readonly redeem: ReturnType<typeof useResetCredit> | null;
};

function SegmentPopover({
  account,
  window,
  reset,
  now,
  redeem,
  onRedeem,
}: SegmentPayload & { readonly now: number; readonly onRedeem: () => void }) {
  const remaining = remainingPercent(window);
  const timeLeft = paceRemainingPercent(window, now);
  const resetsIn = resetsInDuration(window, now);
  const where =
    account.environments.length > 0
      ? account.environments.map((environment) => environment.label).join("、")
      : account.sourceLabel;
  const credits =
    redeem && account.limits.resetCredits?.availableCount ? account.limits.resetCredits : null;
  return (
    <div className="flex w-72 max-w-[calc(100vw-3rem)] flex-col gap-2.5 text-xs">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="flex items-center gap-2 text-sm font-medium text-foreground">
          <AccountAvatar account={account} />
          <span className="truncate">{account.displayName ?? driverLabel(account.driver)}</span>
        </span>
        {account.email ? <RedactedEmail value={account.email} /> : null}
      </div>
      <div className="flex flex-col gap-1 border-t border-border pt-2.5">
        {account.plan ? <Row label="套餐">{account.plan}</Row> : null}
        {where ? <Row label={account.environments.length > 0 ? "登录于" : "来自"}>{where}</Row> : null}
      </div>
      <div className="flex flex-col gap-1 border-t border-border pt-2.5">
        <Row label="剩余">{remaining}%</Row>
        {window.resetsAt ? (
          <Row label="重置">
            {formatUpcomingTimestamp(window.resetsAt, now)}
            {resetsIn ? ` · ${resetsIn === "即将" ? "即将" : `${resetsIn}后`}` : ""}
          </Row>
        ) : null}
        {timeLeft !== null ? <Row label="匀速">此刻应剩 {timeLeft}%</Row> : null}
        {reset && reset.restoresPercent > 0 ? (
          <Row label="恢复">池子 +{reset.restoresPercent}%</Row>
        ) : null}
      </div>
      {credits && redeem ? (
        <div className="border-t border-border pt-2.5 text-muted-foreground">
          <span className="flex items-center gap-3">
            <span className="tabular-nums">{resetCreditsSummary(credits, now, true)}</span>
            <button
              type="button"
              disabled={redeem.busy}
              onClick={onRedeem}
              className="ms-auto inline-flex h-6 items-center rounded-[2px] border border-border-strong px-2 text-xs text-foreground hover:border-foreground disabled:cursor-not-allowed disabled:opacity-40"
            >
              {redeem.busy ? "兑换中…" : "使用重置"}
            </button>
          </span>
        </div>
      ) : null}
    </div>
  );
}

/**
 * 页面上所有分段共用一个浮层：悬停或点击另一个分段会把浮层移过去，而不是再开一个。
 */
interface SegmentPopoverApi {
  readonly show: (payload: SegmentPayload, anchor: HTMLElement, pinned: boolean) => void;
  readonly hideSoon: () => void;
  readonly keep: () => void;
}
const SegmentPopoverContext = createContext<SegmentPopoverApi | null>(null);

interface OpenPopover {
  readonly payload: SegmentPayload;
  readonly anchor: HTMLElement;
  readonly pinned: boolean;
}

function useSegmentPopover() {
  const [open, setOpen] = useState<OpenPopover | null>(null);
  const closeTimer = useRef<number | null>(null);
  const keep = useCallback(() => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }, []);
  const close = useCallback(() => {
    keep();
    setOpen(null);
  }, [keep]);
  const api: SegmentPopoverApi = {
    show: (payload, anchor, pinned) => {
      keep();
      setOpen((previous) =>
        // 已经点开固定的浮层不被悬停别处覆盖
        previous?.pinned && !pinned ? previous : { payload, anchor, pinned },
      );
    },
    hideSoon: () => {
      keep();
      closeTimer.current = window.setTimeout(() => {
        setOpen((previous) => (previous?.pinned ? previous : null));
      }, 150);
    },
    keep,
  };
  return { open, api, close };
}

function FloatingSegmentPopover({
  open,
  api,
  close,
  pools,
  now,
}: {
  readonly open: OpenPopover;
  readonly api: SegmentPopoverApi;
  readonly close: () => void;
  readonly pools: readonly LimitPool[];
  readonly now: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { payload, anchor } = open;
  const available = pools.some((pool) =>
    displayLimitWindows(pool).some((window) =>
      window.members.some(
        (member) =>
          member.account.key === payload.account.key &&
          member.window.id === payload.window.id &&
          member.window.kind === payload.window.kind &&
          Boolean(member.account.redeem) === Boolean(payload.redeem),
      ),
    ),
  );

  // 触发它的分段没了（刷新后账号消失），浮层没有锚点，直接关掉
  useLayoutEffect(() => {
    if (!available || !anchor.isConnected) close();
  }, [available, anchor, close]);

  // 放在分段上方居中，放不下就放到下方，并夹在视口内
  useLayoutEffect(() => {
    const popup = ref.current;
    if (!popup) return;
    const place = () => {
      const rect = anchor.getBoundingClientRect();
      const width = popup.offsetWidth;
      const height = popup.offsetHeight;
      const gap = 6;
      const left = Math.min(
        Math.max(8, rect.left + rect.width / 2 - width / 2),
        window.innerWidth - width - 8,
      );
      const top =
        rect.top - gap - height >= 8 ? rect.top - gap - height : rect.bottom + gap;
      popup.style.left = `${left}px`;
      popup.style.top = `${top}px`;
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchor, payload]);

  // 点外面或按 Esc 关闭
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!ref.current?.contains(target) && !anchor.contains(target)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [anchor, close]);

  if (!available) return null;
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="账号额度详情"
      onMouseEnter={api.keep}
      onMouseLeave={api.hideSoon}
      className="fixed z-40 rounded-[2px] border border-border bg-background p-3 shadow-dialog"
      style={{ left: -9999, top: -9999 }}
    >
      <SegmentPopover
        {...payload}
        now={now}
        onRedeem={() => {
          close();
          payload.redeem?.setConfirming(true);
        }}
      />
    </div>
  );
}

/**
 * 确认弹窗和浮层是兄弟而不是父子：确认弹窗打开时浮层已关闭。
 */
function PoolSegment({
  account,
  ...props
}: {
  readonly account: LimitAccount;
  readonly window: LimitPoolMember["window"];
  readonly reset: LimitPoolWindow["resets"][number] | undefined;
  readonly refillPercent: number;
  readonly color: string;
  readonly now: number;
  readonly index: number;
  readonly showAccountName: boolean;
}) {
  return account.redeem ? (
    <RedeemableSegment account={account} redeemAt={account.redeem} {...props} />
  ) : (
    <SegmentTriggers account={account} redeem={null} {...props} />
  );
}

function RedeemableSegment({
  redeemAt,
  ...props
}: Omit<Parameters<typeof SegmentTriggers>[0], "redeem"> & {
  readonly redeemAt: NonNullable<LimitAccount["redeem"]>;
}) {
  const redeem = useResetCredit(redeemAt.input);
  return (
    <>
      <SegmentTriggers redeem={redeem} {...props} />
      <ResetCreditDialog
        open={redeem.confirming}
        onOpenChange={redeem.setConfirming}
        onConfirm={() => void redeem.redeem()}
      />
      {/* 浮层已在确认前关闭，兑换进度和结果显示在这里 */}
      {redeem.busy || redeem.status ? (
        <span role="status" className="col-span-full text-xs text-muted-foreground">
          <AccountName account={props.account} className="font-medium text-foreground" />{" "}
          {redeem.busy ? "正在使用重置次数…" : redeem.status}
        </span>
      ) : null}
    </>
  );
}

/** 悬停打开、点击固定浮层的触发器属性 */
function useTriggerProps(payload: SegmentPayload) {
  const popover = use(SegmentPopoverContext);
  return {
    onMouseEnter: (event: MouseEvent<HTMLElement>) =>
      popover?.show(payload, event.currentTarget, false),
    onMouseLeave: () => popover?.hideSoon(),
    onFocus: (event: FocusEvent<HTMLElement>) =>
      popover?.show(payload, event.currentTarget, false),
    onClick: (event: MouseEvent<HTMLElement>) =>
      popover?.show(payload, event.currentTarget, true),
  };
}

function SegmentTriggers({
  account,
  window,
  reset,
  redeem,
  refillPercent,
  color,
  now,
  index,
  showAccountName,
}: SegmentPayload & {
  readonly refillPercent: number;
  readonly color: string;
  readonly now: number;
  readonly index: number;
  readonly showAccountName: boolean;
}) {
  const payload: SegmentPayload = { account, window, reset, redeem };
  const triggerProps = useTriggerProps(payload);
  const remaining = remainingPercent(window);
  const timeLeft = paceRemainingPercent(window, now);
  const [segmentRef, paceMark] = usePaceMark(timeLeft);
  const resetsIn = resetsInDuration(window, now);
  const resetsText = formatResetsIn(window, now);
  const credits = account.limits.resetCredits?.availableCount ?? 0;
  return (
    <>
      <button
        ref={segmentRef}
        type="button"
        {...triggerProps}
        style={{ gridColumn: index, gridRow: 1, ...paceMark?.gappedTrack }}
        aria-label={`${account.displayName ?? (account.email ? accountInitials(account.email) : driverLabel(account.driver))}：剩余 ${remaining}%${resetsText ? `，${resetsText}` : ""}${timeLeft === null ? "" : `，周期还剩 ${timeLeft}%`}${credits ? `，剩 ${credits} 次重置` : ""}`}
        className="relative h-5 min-w-0 cursor-pointer rounded-[2px] bg-muted text-start outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset @2xl/pool:h-8"
      >
        <div aria-hidden className="absolute inset-0 overflow-hidden rounded-[2px]">
          {/* 裁剪放在圆角容器里面，进度条自己的圆角保持抗锯齿 */}
          <div className="absolute inset-0" style={paceMark?.gap}>
            <div
              aria-hidden
              className="absolute inset-y-0 left-0 rounded-[2px] opacity-35"
              style={{ width: `${remaining}%`, backgroundColor: color }}
            />
            {remaining < 100 && reset && refillPercent > 0 ? (
              <div
                aria-hidden
                className="absolute inset-y-0 right-0 opacity-20"
                style={{
                  width: `${Math.min(100 - remaining, refillPercent)}%`,
                  backgroundImage: `repeating-linear-gradient(135deg, ${color} 0 1px, transparent 1px 5px)`,
                }}
              />
            ) : null}
          </div>
        </div>
        {paceMark ? (
          <span
            aria-hidden
            className="absolute inset-y-0.5 w-0.5 -translate-x-1/2 rounded-full bg-foreground"
            style={paceMark.tick}
          />
        ) : null}
        <span
          aria-hidden
          className="absolute inset-0 flex items-center justify-center overflow-hidden rounded-[2px] text-[9px] leading-none font-semibold text-foreground/80 tabular-nums @2xl/pool:hidden"
        >
          {index}
        </span>
        <div className="relative hidden h-full min-w-0 items-center gap-1.5 overflow-hidden rounded-[2px] px-2 text-xs @2xl/pool:flex">
          {showAccountName ? (
            <AccountName
              account={account}
              className="min-w-0 truncate font-medium text-foreground"
            />
          ) : null}
          {/* 只有一个账号时，条上的百分比和标题重复，不显示 */}
          {showAccountName ? (
            <span className="shrink-0 font-semibold text-foreground tabular-nums">
              {remaining}%
            </span>
          ) : null}
          {resetsIn || credits ? (
            <span className="ms-auto flex min-w-0 items-center gap-1.5 overflow-hidden rounded-[2px] bg-background/85 px-1.5 py-0.5 text-[11px] whitespace-nowrap text-foreground tabular-nums">
              {resetsIn ? `↻ ${resetsIn}` : ""}
              {credits ? (
                <>
                  {resetsIn ? (
                    <span aria-hidden className="text-muted-foreground">
                      ·
                    </span>
                  ) : null}
                  <span aria-hidden className="inline-flex items-center gap-0.5 font-semibold">
                    <TicketIcon className="size-3" />
                    {credits}
                  </span>
                </>
              ) : null}
            </span>
          ) : null}
        </div>
      </button>
      <LegendRow payload={payload} color={color} now={now} index={index} />
    </>
  );
}

/** 窄屏时进度条只显示序号，下面逐行列出每个账号 */
function LegendRow({
  payload,
  color,
  now,
  index,
}: {
  readonly payload: SegmentPayload;
  readonly color: string;
  readonly now: number;
  readonly index: number;
}) {
  const triggerProps = useTriggerProps(payload);
  const { account, window } = payload;
  const remaining = remainingPercent(window);
  const resetsIn = resetsInDuration(window, now);
  const credits = account.limits.resetCredits?.availableCount ?? 0;
  return (
    <button
      type="button"
      {...triggerProps}
      style={{ gridColumn: "1 / -1", gridRow: index + 1 }}
      className="flex h-7 min-w-0 items-center gap-2 rounded-[2px] px-1.5 text-left text-xs hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary @2xl/pool:hidden"
    >
      <span className="relative inline-flex size-4 shrink-0 items-center justify-center rounded-[2px] text-[9px] leading-none font-semibold text-foreground/80 tabular-nums">
        <span
          aria-hidden
          className="absolute inset-0 rounded-[2px] opacity-35"
          style={{ backgroundColor: color }}
        />
        <span className="relative">{index}</span>
      </span>
      <AccountName account={account} className="min-w-0 truncate font-medium text-foreground" />
      <span className="shrink-0 font-semibold text-foreground tabular-nums">{remaining}%</span>
      <span className="ms-auto flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground tabular-nums">
        {resetsIn ? `↻ ${resetsIn}` : ""}
        {credits ? (
          <>
            {resetsIn ? <span aria-hidden>·</span> : null}
            <span aria-hidden className="inline-flex items-center gap-0.5 font-semibold text-foreground">
              <TicketIcon className="size-3" />
              {credits}
            </span>
            <span className="sr-only">剩 {credits} 次重置</span>
          </>
        ) : null}
      </span>
    </button>
  );
}

function PoolBar({
  pool,
  color,
  now,
}: {
  readonly pool: LimitPoolWindow;
  readonly color: string;
  readonly now: number;
}) {
  const restores = new Map(pool.resets.map((reset) => [reset.member.account.key, reset]));
  return (
    <div className="@container/pool min-w-0">
      <div
        className="grid gap-x-1 gap-y-1"
        style={{ gridTemplateColumns: `repeat(${pool.columns.length}, minmax(0, 1fr))` }}
      >
        {pool.columns.map((member, position) =>
          member.window ? (
            <PoolSegment
              key={member.account.key}
              account={member.account}
              window={member.window}
              reset={restores.get(member.account.key)}
              refillPercent={member.refillPercent}
              color={color}
              now={now}
              index={position + 1}
              showAccountName={pool.columns.length > 1}
            />
          ) : null,
        )}
      </div>
    </div>
  );
}

function PoolWindowCard({
  pool,
  color,
  now,
  label,
  description,
}: {
  readonly pool: LimitPoolWindow;
  readonly color: string;
  readonly now: number;
  readonly label?: string | undefined;
  readonly description?: string | undefined;
}) {
  const nextRefill = pool.resets.find((reset) => reset.restoresPercent > 0);
  return (
    <div className="grid items-center gap-x-6 gap-y-3 rounded-[2px] border border-border p-4 md:grid-cols-[11rem_minmax(0,1fr)]">
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium text-foreground">{label ?? pool.label}</span>
        <span className="flex items-baseline gap-2">
          <span className="text-3xl font-semibold text-foreground tabular-nums">
            {pool.remainingPercent}%
          </span>
          <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
            <span>剩余</span>
            {pool.pace ? <PaceIcon pace={pool.pace} /> : null}
          </span>
        </span>
        {nextRefill && pool.columns.length > 1 ? (
          <span className="text-xs font-medium text-foreground tabular-nums">
            ↻ +{nextRefill.restoresPercent}%
          </span>
        ) : null}
      </div>
      <PoolBar pool={pool} color={color} now={now} />
      {description ? (
        <p className="text-xs text-muted-foreground md:col-span-2">{description}</p>
      ) : null}
    </div>
  );
}

function PoolSection({ pool, now }: { readonly pool: LimitPool; readonly now: number }) {
  const color = barColor(pool.driver);
  const windows = displayLimitWindows(pool);
  return (
    <section className="flex flex-col gap-3">
      <h2 className="flex items-center gap-2 text-sm font-medium text-foreground">
        <DriverMark driver={pool.driver} />
        {driverLabel(pool.driver)}
      </h2>
      {windows.map((window) => {
        const details = pool.driver === "cursor" ? cursorUsageWindowDetails(window.id) : undefined;
        return (
          <PoolWindowCard
            key={`${window.kind}:${window.id}`}
            pool={window}
            color={color}
            now={now}
            label={details?.label}
            description={details?.description}
          />
        );
      })}
    </section>
  );
}

export function UsageLimitsPooled({
  presentations,
  now,
  cursorPrompt,
}: {
  readonly presentations: LimitPresentations;
  readonly now: number;
  readonly cursorPrompt?: ReactNode;
}) {
  const { open, api, close } = useSegmentPopover();
  const pools = collectLimitPools(collectLimitAccounts(presentations), now);
  const notices = collectLimitNotices(presentations);
  const externalLinks = collectExternalUsageLinks(presentations);
  const cursorPromptAt =
    Math.max(
      pools.findIndex((pool) => pool.driver === "codex"),
      pools.findIndex((pool) => pool.driver === "claudeAgent"),
    ) + 1;
  return (
    <div className="flex flex-col gap-8">
      {pools.length === 0 && notices.length === 0 && !cursorPrompt && externalLinks.length === 0 ? (
        <p className="text-sm text-muted-foreground">本机没有提供方返回订阅额度。</p>
      ) : null}
      <SegmentPopoverContext value={api}>
        {pools.map((pool, index) => (
          <Fragment key={pool.driver}>
            {index === cursorPromptAt ? cursorPrompt : null}
            <PoolSection pool={pool} now={now} />
          </Fragment>
        ))}
      </SegmentPopoverContext>
      {open ? (
        <FloatingSegmentPopover open={open} api={api} close={close} pools={pools} now={now} />
      ) : null}
      {cursorPromptAt === pools.length ? cursorPrompt : null}
      {externalLinks.map((link) => (
        <section
          key={link.url}
          className="flex flex-wrap items-center justify-between gap-3 rounded-[2px] border border-border p-4"
        >
          <div className="min-w-0 flex-1 space-y-1">
            <h2 className="text-sm font-medium">{link.label}</h2>
            {link.url === CHATGPT_USAGE_URL ? (
              <p className="text-xs text-muted-foreground">用已连接的账号在 ChatGPT 里查看用量。</p>
            ) : link.message ? (
              <p className="max-w-xl text-xs text-muted-foreground">{link.message}</p>
            ) : null}
          </div>
          <a
            href={link.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs text-secondary-foreground hover:text-foreground"
          >
            管理用量
            <ExternalLinkIcon className="size-3.5" />
          </a>
        </section>
      ))}
      <LimitNotices notices={notices} />
    </div>
  );
}

function LimitNotices({ notices }: { readonly notices: readonly string[] }) {
  if (notices.length === 0) return null;
  return (
    <div
      role="alert"
      className="flex gap-2 rounded-[2px] border border-border p-3 text-xs text-warning-foreground"
    >
      <AlertIcon className="mt-0.5 size-3.5 shrink-0" />
      <div className="flex min-w-0 flex-col gap-1">
        {notices.map((notice) => (
          <p key={notice} className="break-words">
            {notice}
          </p>
        ))}
      </div>
    </div>
  );
}
