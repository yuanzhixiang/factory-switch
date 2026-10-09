import { useState } from "react";
import type { OperationResult, SavedAccount } from "../../../shared/types";
import { formatTime, shortId } from "../../lib/format";
import { Button } from "../shared/Button";
import { ConfirmDialog } from "../shared/ConfirmDialog";
import { NameDialog } from "../shared/NameDialog";

type Run = (operation: () => Promise<OperationResult>) => void;

/** 正在打开的弹窗：切换确认、改名、删除确认 */
type Pending =
  | { kind: "switch"; account: SavedAccount }
  | { kind: "rename"; account: SavedAccount }
  | { kind: "remove"; account: SavedAccount }
  | null;

/** 已备份账号列表，每行可切换、改名、删除 */
export function AccountList({
  accounts,
  currentAccountId,
  busy,
  run,
}: {
  accounts: SavedAccount[];
  currentAccountId: string | null;
  busy: boolean;
  run: Run;
}) {
  const [pending, setPending] = useState<Pending>(null);
  const close = () => setPending(null);

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3">
      <h2 className="text-sm font-medium text-muted-foreground">
        已备份的账号
      </h2>
      <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-border bg-card">
        {accounts.length === 0 ? (
          <p className="p-6 text-center text-sm text-muted-foreground">
            还没有备份任何账号，先点上面的「备份当前账号」。
          </p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="sticky top-0 bg-card text-xs text-muted-foreground">
              <tr className="border-b border-border">
                <th className="px-4 py-2 font-medium">名字</th>
                <th className="px-4 py-2 font-medium">userId</th>
                <th className="px-4 py-2 font-medium">orgId</th>
                <th className="px-4 py-2 font-medium">备份时间</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {accounts.map((account) => (
                <AccountRow
                  key={account.id}
                  account={account}
                  isCurrent={account.id === currentAccountId}
                  busy={busy}
                  onAction={(kind) => setPending({ kind, account })}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>

      {pending?.kind === "switch" && (
        <ConfirmDialog
          title={`切换到「${pending.account.label}」`}
          confirmLabel="切换"
          onClose={close}
          onConfirm={() =>
            run(() => window.factorySwitch.switchTo(pending.account.id))
          }
        >
          <p>
            将退出
            Factory（正在运行的会话会中断），换入这个账号的凭证后重新打开。
          </p>
        </ConfirmDialog>
      )}
      {pending?.kind === "rename" && (
        <NameDialog
          title="修改名字"
          initialValue={pending.account.label}
          onClose={close}
          onSubmit={(label) => {
            close();
            run(() =>
              window.factorySwitch.renameAccount(pending.account.id, label),
            );
          }}
        />
      )}
      {pending?.kind === "remove" && (
        <ConfirmDialog
          title={`删除「${pending.account.label}」的备份`}
          confirmLabel="删除"
          danger
          onClose={close}
          onConfirm={() =>
            run(() => window.factorySwitch.removeAccount(pending.account.id))
          }
        >
          <p>
            只删除本程序里的备份，不影响 Factory 当前的登录。备份文件会移到
            ~/.factory-switch/backups。
          </p>
        </ConfirmDialog>
      )}
    </section>
  );
}

/** 列表中的一行 */
function AccountRow({
  account,
  isCurrent,
  busy,
  onAction,
}: {
  account: SavedAccount;
  isCurrent: boolean;
  busy: boolean;
  onAction: (kind: "switch" | "rename" | "remove") => void;
}) {
  return (
    <tr className="border-b border-border last:border-b-0">
      <td className="px-4 py-3">
        <div className="font-medium">{account.label}</div>
        {account.email && account.email !== account.label && (
          <div className="text-xs text-muted-foreground">{account.email}</div>
        )}
      </td>
      <td
        className="px-4 py-3 font-mono text-xs text-muted-foreground"
        title={account.userId}
      >
        {shortId(account.userId)}
      </td>
      <td
        className="px-4 py-3 font-mono text-xs text-muted-foreground"
        title={account.orgId}
      >
        {shortId(account.orgId)}
      </td>
      <td className="px-4 py-3 text-xs text-muted-foreground">
        {formatTime(account.savedAt)}
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center justify-end gap-2">
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => onAction("rename")}
          >
            改名
          </Button>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => onAction("remove")}
          >
            删除
          </Button>
          {isCurrent ? (
            <span className="w-[60px] text-center text-xs font-medium text-success">
              当前
            </span>
          ) : (
            <Button
              variant="primary"
              className="w-[60px]"
              disabled={busy}
              onClick={() => onAction("switch")}
            >
              切换
            </Button>
          )}
        </div>
      </td>
    </tr>
  );
}
