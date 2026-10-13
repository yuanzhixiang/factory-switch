import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { CursorCurrentState } from "../../../shared/types";
import { Button } from "../shared/Button";
import { Modal } from "../shared/Modal";
import { Section } from "../shared/Section";

// 纯界面示例，使用保留的 .invalid 域名，不对应真实账号或运行状态。
const EXAMPLES = [
  { id: "work", label: "工作账号", email: "work@example.invalid", status: "示例当前账号", sync: "示例 · 已同步" },
  { id: "personal", label: "个人账号", email: "personal@example.invalid", status: "示例 · 已登录", sync: "示例 · 待同步" },
  { id: "spare", label: "备用账号", email: "spare@example.invalid", status: "示例 · 需要登录", sync: "—" },
];
const STEPS = ["退出 Cursor", "保存最新会话", "同步目标目录", "打开目标账号"];

/** Cursor 页面原型：只使用内存状态，没有 IPC、文件访问或账号操作。 */
export function CursorPage({ productSwitcher }: { productSwitcher: ReactNode }) {
  const [showExamples, setShowExamples] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"add" | "switch" | "login" | null>(null);
  const [targetLabel, setTargetLabel] = useState("");
  const [current, setCurrent] = useState<CursorCurrentState | null>(null);
  const [reading, setReading] = useState(true);
  const refresh = useCallback(async () => {
    setReading(true);
    try {
      setCurrent(await window.factorySwitch.getCursorCurrent());
    } catch {
      setCurrent({ kind: "unreadable", dataDirectory: "—", checkedAt: Date.now(), message: "账号读取失败，请稍后刷新" });
    } finally { setReading(false); }
  }, []);
  useEffect(() => {
    let active = true;
    void window.factorySwitch.getCursorCurrent().then((result) => {
      if (active) setCurrent(result);
    }).catch(() => {
      if (active) setCurrent({ kind: "unreadable", dataDirectory: "—", checkedAt: Date.now(), message: "账号读取失败，请稍后刷新" });
    }).finally(() => { if (active) setReading(false); });
    return () => { active = false; };
  }, []);
  const realAccount = current?.kind === "identified" ? {
    id: "current", label: current.name ?? current.email ?? "当前本地账号",
    email: current.email ?? "邮箱缓存不可用", status: "已识别 · 未验证", sync: "未接入",
  } : null;
  const accounts = showExamples ? EXAMPLES : realAccount ? [realAccount] : [];
  const selected = accounts.find((account) => account.id === selectedId);
  const isReal = selected?.id === "current";
  const localStatus = current?.kind === "identified"
    ? current.tokenStatus === "expired" ? "已到期" : current.tokenStatus === "unexpired" ? "未到期" : "到期时间未知"
    : "—";

  function preview(action: "switch" | "login", label: string) {
    setTargetLabel(label);
    setDialog(action);
  }

  return (
    <div className="flex h-screen">
      <aside className="flex w-[240px] shrink-0 flex-col gap-6 border-r border-border bg-sidebar px-3 py-5">
        <div className="flex items-center gap-2 px-2 text-sm font-medium tracking-[0.08em]">
          <span className="text-primary" aria-hidden>✻</span> FACTORY SWITCH
        </div>
        {productSwitcher}
        <nav aria-label="Cursor 账号导航" className="flex min-h-0 flex-1 flex-col gap-1 overflow-auto">
          <p className="px-2 pb-1 text-[11px] text-muted-foreground">概览</p>
          <button type="button" onClick={() => setSelectedId(null)} aria-current={!selected ? "page" : undefined}
            className={`flex h-8 items-center gap-2 rounded-[2px] px-2 text-left text-[13px] ${!selected ? "bg-muted" : "hover:bg-muted"}`}>
            <span className="text-muted-foreground" aria-hidden>∑</span> 全部账号
            <span className="ml-auto text-[11px] text-muted-foreground">{accounts.length}</span>
          </button>
          <p className="px-2 pt-5 pb-1 text-[11px] text-muted-foreground">账号</p>
          {accounts.length === 0 && <p className="px-2 text-muted-foreground">还没有接入账号</p>}
          {accounts.map((account) => (
            <button key={account.id} type="button" onClick={() => setSelectedId(account.id)}
              aria-current={selectedId === account.id ? "page" : undefined}
              className={`flex h-8 items-center gap-2 rounded-[2px] px-2 text-left text-[13px] ${selectedId === account.id ? "bg-muted" : "hover:bg-muted"}`}>
              <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${account.id === "work" || account.id === "current" ? "bg-primary" : "bg-transparent"}`} />
              {account.label}
              <span className="ml-auto text-[10px] text-muted-foreground">{showExamples ? "示例" : "本地"}</span>
            </button>
          ))}
        </nav>
        <p className="px-2 text-[11px] text-muted-foreground">Cursor 状态未读取</p>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <main className="flex min-h-0 flex-1 flex-col gap-10 overflow-auto px-10 py-8">
          <div className="flex items-start justify-between gap-4">
            <div className="flex flex-col gap-2">
              <h1 className="text-sm">{selected ? selected.label : "Cursor 账号"}</h1>
              <p className="leading-5 text-muted-foreground">独立账号目录，共享本地会话。</p>
            </div>
            <div className="flex gap-2">
              <Button disabled={reading} onClick={() => void refresh()}>{reading ? "读取中…" : "刷新账号"}</Button>
              <Button onClick={() => setDialog("add")}>+ 添加账号</Button>
            </div>
          </div>

          <div className="flex items-center justify-between gap-4 border border-border bg-sidebar px-4 py-3">
            <div className="flex flex-col gap-1 leading-5">
              <p>{showExamples ? "正在查看布局示例" : "当前账号 · 只读识别"}</p>
              <p className="text-muted-foreground">{showExamples ? "下方账号及同步状态均为示例，不对应本机数据。" : "仅读取默认目录的本地账号信息，未向服务器验证登录有效性。"}</p>
            </div>
            <Button onClick={() => { setShowExamples(!showExamples); setSelectedId(null); }}>
              {showExamples ? "返回真实账号" : "查看布局示例"}
            </Button>
          </div>

          {!showExamples && current?.kind === "unreadable" && <p role="alert" className="leading-5 text-destructive-foreground">{current.message}</p>}
          {!showExamples && current?.kind === "identified" && current.cacheMismatch &&
            <p role="status" className="leading-5 text-warning-foreground">部分缓存属于其他账号，已隐藏不匹配的信息。账号 ID 以当前凭证声明为准。</p>}

          {selected ? (
            <Section title="账号详情">
              <dl className="grid grid-cols-[100px_1fr] gap-x-4 gap-y-4">
                <dt className="text-muted-foreground">邮箱</dt><dd>{selected.email}</dd>
                <dt className="text-muted-foreground">账号状态</dt><dd>{selected.status}</dd>
                {isReal && current?.kind === "identified" && <>
                  <dt className="text-muted-foreground">账号 ID</dt><dd className="break-all">{current.userId}</dd>
                  <dt className="text-muted-foreground">凭证状态</dt><dd>{localStatus} · {current.hasRefreshToken ? "有刷新凭证" : "无刷新凭证"}</dd>
                  <dt className="text-muted-foreground">声明到期时间</dt><dd>{current.expiresAt ? new Date(current.expiresAt).toLocaleString("zh-CN") : "—"}</dd>
                  <dt className="text-muted-foreground">订阅缓存</dt><dd>{current.membership ?? "—"} / {current.subscription ?? "—"}（未向服务器验证）</dd>
                </>}
                <dt className="text-muted-foreground">{isReal ? "当前数据目录" : "独立目录"}</dt><dd className="break-all">{isReal ? current?.dataDirectory : "尚未创建"}</dd>
                <dt className="text-muted-foreground">上次使用</dt><dd>—</dd>
                <dt className="text-muted-foreground">同步记录</dt><dd>尚未执行同步</dd>
              </dl>
              {!isReal && <div className="mt-2 flex gap-2">
                <Button onClick={() => preview(selected.id === "spare" ? "login" : "switch", selected.label)}>
                  {selected.id === "spare" ? "查看登录流程" : "查看切换流程"}
                </Button>
              </div>}
            </Section>
          ) : (
            <Section title="账号列表">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="text-muted-foreground">
                    <tr className="border-b border-border">
                      <th className="pb-3 font-normal">账号</th><th className="pb-3 font-normal">状态</th>
                      <th className="pb-3 font-normal">会话同步</th><th className="pb-3 text-right font-normal">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {accounts.map((account) => (
                      <tr key={account.id} className="border-b border-border last:border-0">
                        <td className="py-4 pr-4">
                          <button type="button" onClick={() => setSelectedId(account.id)} className="text-left hover:text-primary">
                            <span className="block">{account.label}</span>
                            <span className="mt-1 block text-[11px] text-muted-foreground">{account.email}</span>
                          </button>
                        </td>
                        <td className="py-4 pr-4 whitespace-nowrap">{account.status}</td>
                        <td className="py-4 pr-4 whitespace-nowrap text-muted-foreground">{account.sync}</td>
                        <td className="py-4 text-right">
                          {account.id === "work" || account.id === "current" ? <span className="rounded-[2px] bg-accent px-2 py-1 text-primary">{showExamples ? "示例当前" : "本地账号"}</span> :
                            <Button onClick={() => preview(account.id === "spare" ? "login" : "switch", account.label)}>
                              {account.id === "spare" ? "预览登录" : "预览切换"}
                            </Button>}
                        </td>
                      </tr>
                    ))}
                    {accounts.length === 0 && (
                      <tr><td colSpan={4} className="py-9 text-center">
                        <p>{reading ? "正在读取本地账号…" : current?.kind === "unreadable" ? "无法识别本地账号" : "未发现 Cursor 本地登录凭证"}</p>
                        <p className="mt-2 text-muted-foreground">{reading ? "" : "可以在 Cursor 中检查登录状态后刷新；也可以查看布局示例。"}</p>
                      </td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </Section>
          )}

          <Section title="共享本地会话">
            <div className="flex items-center justify-between gap-4">
              <p className="text-muted-foreground">上次同步：— · 会话数量：—</p>
              <span className="rounded-[2px] bg-muted px-2 py-1 text-[11px] text-muted-foreground">待接入</span>
            </div>
            <p className="leading-5 text-secondary-foreground">接入后，切换时自动同步本地会话，并保留目标账号的登录态。一次只运行一个受管理的 Cursor 实例。</p>
            <ol className="mt-2 grid grid-cols-2 gap-3 xl:grid-cols-4">
              {STEPS.map((step, index) => (
                <li key={step} className="flex items-center gap-2 border-t border-border pt-3">
                  <span className="text-[11px] tabular-nums text-muted-foreground">0{index + 1}</span>{step}
                </li>
              ))}
            </ol>
            <p className="text-[11px] leading-5 text-muted-foreground">本地会话迁移仍需真实格式验证；云端任务和团队资源按账号权限访问。</p>
          </Section>
        </main>
        <footer className="flex min-h-[64px] items-center border-t border-border px-10 py-3 text-[11px] text-muted-foreground">
          {showExamples ? "状态：布局示例" : reading ? "状态：正在只读识别…" : `状态：只读识别 · ${current ? new Date(current.checkedAt).toLocaleTimeString("zh-CN") : "—"} · 登录有效性未验证`}
        </footer>
      </div>

      {dialog && (
        <Modal title={dialog === "add" ? "添加 Cursor 账号" : dialog === "login" ? `登录「${targetLabel}」` : `切换到「${targetLabel}」`} onClose={() => setDialog(null)}>
          <div className="flex flex-col gap-3 text-xs leading-5 text-secondary-foreground">
            <p className="text-muted-foreground">流程预览 · 尚未开放操作</p>
            {dialog === "add" || dialog === "login" ? (
              <>
                <p>为账号创建独立数据目录，通过 Cursor 官方登录流程登录一次，以后从这里打开或切换。</p>
                <ol className="list-inside list-decimal space-y-1"><li>给账号起名字</li><li>创建独立目录并打开 Cursor</li><li>完成登录后确认账号身份</li></ol>
              </>
            ) : (
              <>
                <p>接入后，将退出当前 Cursor，同步本地会话，然后打开目标账号的独立目录。切换前请保存文件并结束正在运行的任务。</p>
                <ol className="list-inside list-decimal space-y-1">{STEPS.map((step) => <li key={step}>{step}</li>)}</ol>
              </>
            )}
            <p>此弹窗仅说明流程，不会创建目录、修改凭证、同步会话或退出 Cursor。</p>
          </div>
          <div className="flex justify-end gap-2">
            <Button onClick={() => setDialog(null)}>关闭</Button>
            <Button disabled variant="primary">{dialog === "switch" ? "同步并切换（待接入）" : "添加账号（待接入）"}</Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
