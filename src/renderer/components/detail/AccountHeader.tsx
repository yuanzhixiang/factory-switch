import { useState } from "react";
import type { Run } from "../../lib/run";
import type { AccountView } from "../../lib/accounts";
import { shortId } from "../../lib/format";
import { Button } from "../shared/Button";
import { ConfirmDialog } from "../shared/ConfirmDialog";

/** 详情页顶部：账号名字和身份，右上角是「当前登录」标记或「切换到此账号」 */
export function AccountHeader({
  account,
  busy,
  run,
}: {
  account: AccountView;
  busy: boolean;
  run: Run;
}) {
  const [confirming, setConfirming] = useState(false);

  return (
    <header className="flex items-start justify-between gap-6">
      <div className="flex min-w-0 flex-col gap-2">
        <h1 className="truncate text-lg">
          {account.isSaved ? account.label : "未备份的账号"}
        </h1>
        <p className="text-secondary-foreground">
          {[account.email, account.name].filter(Boolean).join(" · ")}
        </p>
        <p className="flex gap-4 font-mono text-[11px] text-muted-foreground">
          <span title={account.userId}>userId {shortId(account.userId)}</span>
          <span title={account.orgId}>orgId {shortId(account.orgId)}</span>
        </p>
      </div>

      {account.isCurrent ? (
        <span className="flex h-6 shrink-0 items-center rounded-[2px] bg-accent px-3 text-xs text-primary-hover">
          当前登录
        </span>
      ) : (
        <Button
          variant="primary"
          disabled={busy}
          onClick={() => setConfirming(true)}
        >
          切换到此账号
        </Button>
      )}

      {confirming && (
        <ConfirmDialog
          title={`切换到「${account.label}」`}
          confirmLabel="切换"
          onClose={() => setConfirming(false)}
          onConfirm={() => run(() => window.factorySwitch.switchTo(account.id))}
        >
          <p>
            将退出
            Factory（正在运行的会话会中断），换入这个账号的凭证后重新打开。
          </p>
        </ConfirmDialog>
      )}
    </header>
  );
}
