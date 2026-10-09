import { useState } from "react";
import type {
  CurrentStatus,
  OperationResult,
  SavedAccount,
} from "../../../shared/types";
import { shortId } from "../../lib/format";
import { Button } from "../shared/Button";
import { ConfirmDialog } from "../shared/ConfirmDialog";
import { NameDialog } from "../shared/NameDialog";

type Run = (operation: () => Promise<OperationResult>) => void;

/** 当前登录账号卡片：显示身份，提供「备份当前账号」和「删除本地凭证」 */
export function CurrentAccountCard({
  current,
  accounts,
  busy,
  run,
}: {
  current: CurrentStatus;
  accounts: SavedAccount[];
  busy: boolean;
  run: Run;
}) {
  const [naming, setNaming] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const signedIn = current.kind === "signed-in";
  const saved = signedIn
    ? (accounts.find((account) => account.id === current.savedAccountId) ??
      null)
    : null;

  // 已备份过的账号直接覆盖更新，不再问名字
  const handleBackup = () => {
    if (saved) {
      run(() => window.factorySwitch.backupCurrent(null));
    } else {
      setNaming(true);
    }
  };

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium text-muted-foreground">当前登录</h2>
      <div className="flex flex-col gap-4 rounded-lg border border-border bg-card p-5">
        <CurrentIdentity current={current} savedLabel={saved?.label ?? null} />
        <div className="flex gap-3">
          <Button
            variant="primary"
            disabled={busy || !signedIn}
            onClick={handleBackup}
          >
            备份当前账号
          </Button>
          <Button
            variant="danger"
            disabled={busy || current.kind === "signed-out"}
            onClick={() => setConfirmingDelete(true)}
          >
            删除本地凭证
          </Button>
        </div>
      </div>

      {naming && current.kind === "signed-in" && (
        <NameDialog
          title="给这个账号起个名字"
          initialValue={current.identity.email ?? ""}
          onClose={() => setNaming(false)}
          onSubmit={(name) => {
            setNaming(false);
            run(() => window.factorySwitch.backupCurrent(name));
          }}
        />
      )}

      {confirmingDelete && (
        <ConfirmDialog
          title="删除本地凭证"
          confirmLabel="删除并打开 Factory"
          danger
          onClose={() => setConfirmingDelete(false)}
          onConfirm={() =>
            run(() => window.factorySwitch.deleteLocalCredentials())
          }
        >
          <p>将退出 Factory 并删除本地凭证，Factory 重新打开后会进入登录页。</p>
          {signedIn && !saved && (
            <p className="rounded-md bg-warning-muted px-3 py-2 text-warning-foreground">
              当前账号还没有备份。删除后凭证只会留在 ~/.factory-switch/backups
              里，列表里不会出现。
            </p>
          )}
          {saved && <p>「{saved.label}」会先自动更新备份，再删除。</p>}
        </ConfirmDialog>
      )}
    </section>
  );
}

/** 卡片上半部分：按登录状态显示身份或提示 */
function CurrentIdentity({
  current,
  savedLabel,
}: {
  current: CurrentStatus;
  savedLabel: string | null;
}) {
  if (current.kind === "signed-out") {
    return (
      <div className="flex flex-col gap-1">
        <p className="font-medium">本地没有登录凭证</p>
        <p className="text-sm text-muted-foreground">
          在 Factory 里登录一个账号后回到这里，点「备份当前账号」。
        </p>
      </div>
    );
  }
  if (current.kind === "unreadable") {
    return (
      <div className="flex flex-col gap-1">
        <p className="font-medium text-destructive">读不出当前凭证</p>
        <p className="text-sm text-muted-foreground">{current.message}</p>
      </div>
    );
  }
  const { identity } = current;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <span className="size-2 rounded-full bg-success" aria-hidden />
        <span className="font-medium">
          {savedLabel ?? identity.email ?? identity.userId}
        </span>
        <span
          className={`rounded px-2 py-0.5 text-xs ${savedLabel ? "bg-muted text-muted-foreground" : "bg-warning-muted text-warning-foreground"}`}
        >
          {savedLabel ? "已备份" : "未备份"}
        </span>
      </div>
      <p className="text-sm text-muted-foreground">
        {[identity.email, identity.name].filter(Boolean).join(" · ")}
      </p>
      <p className="flex gap-4 font-mono text-xs text-muted-foreground">
        <span>userId {shortId(identity.userId)}</span>
        <span>orgId {shortId(identity.orgId)}</span>
      </p>
    </div>
  );
}
