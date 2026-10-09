import { useState } from "react";
import type { Run } from "../../lib/run";
import type { AccountView } from "../../lib/accounts";
import { formatTime } from "../../lib/format";
import { Button } from "../shared/Button";
import { ConfirmDialog } from "../shared/ConfirmDialog";
import { NameDialog } from "../shared/NameDialog";
import { Section } from "../shared/Section";

type Dialog = "name-backup" | "delete-credentials" | "rename" | "remove" | null;

/** 操作区块：当前账号可备份、删除本地凭证；已备份账号可改名、删除备份 */
export function AccountActions({
  account,
  busy,
  run,
}: {
  account: AccountView;
  busy: boolean;
  run: Run;
}) {
  const [dialog, setDialog] = useState<Dialog>(null);
  const close = () => setDialog(null);

  // 已备份过的账号直接覆盖更新，不再问名字
  const handleBackup = () => {
    if (account.isSaved) {
      run(() => window.factorySwitch.backupCurrent(null));
    } else {
      setDialog("name-backup");
    }
  };

  return (
    <Section title="Actions">
      {account.savedAt !== null && (
        <p className="text-[11px] text-muted-foreground">
          最近备份 {formatTime(account.savedAt)}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {account.isCurrent && (
          <>
            <Button variant="primary" disabled={busy} onClick={handleBackup}>
              备份当前账号
            </Button>
            <Button
              variant="danger"
              disabled={busy}
              onClick={() => setDialog("delete-credentials")}
            >
              删除本地凭证
            </Button>
          </>
        )}
        {account.isSaved && (
          <>
            <Button disabled={busy} onClick={() => setDialog("rename")}>
              改名
            </Button>
            {!account.isCurrent && (
              <Button
                variant="danger"
                disabled={busy}
                onClick={() => setDialog("remove")}
              >
                删除备份
              </Button>
            )}
          </>
        )}
      </div>

      {dialog === "name-backup" && (
        <NameDialog
          title="给这个账号起个名字"
          initialValue={account.email ?? ""}
          onClose={close}
          onSubmit={(name) => {
            close();
            run(() => window.factorySwitch.backupCurrent(name));
          }}
        />
      )}
      {dialog === "rename" && (
        <NameDialog
          title="修改名字"
          initialValue={account.label}
          onClose={close}
          onSubmit={(label) => {
            close();
            run(() => window.factorySwitch.renameAccount(account.id, label));
          }}
        />
      )}
      {dialog === "delete-credentials" && (
        <ConfirmDialog
          title="删除本地凭证"
          confirmLabel="删除并打开 Factory"
          danger
          onClose={close}
          onConfirm={() =>
            run(() => window.factorySwitch.deleteLocalCredentials())
          }
        >
          <p>将退出 Factory 并删除本地凭证，Factory 重新打开后会进入登录页。</p>
          {account.isSaved ? (
            <p>「{account.label}」会先自动更新备份，再删除。</p>
          ) : (
            <p className="text-warning-foreground">
              当前账号还没有备份。删除后凭证只会留在 ~/.factory-switch/backups
              里，列表里不会出现。
            </p>
          )}
        </ConfirmDialog>
      )}
      {dialog === "remove" && (
        <ConfirmDialog
          title={`删除「${account.label}」的备份`}
          confirmLabel="删除"
          danger
          onClose={close}
          onConfirm={() =>
            run(() => window.factorySwitch.removeAccount(account.id))
          }
        >
          <p>
            只删除本程序里的备份和 API Key，不影响 Factory
            当前的登录。文件会移到 ~/.factory-switch/backups。
          </p>
        </ConfirmDialog>
      )}
    </Section>
  );
}
