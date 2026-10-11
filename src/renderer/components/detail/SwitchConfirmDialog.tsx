import type { AccountView } from "../../lib/accounts";
import type { Run } from "../../lib/run";
import { ConfirmDialog } from "../shared/ConfirmDialog";

/** 切换账号前的二次确认，详情页和汇总页共用 */
export function SwitchConfirmDialog({
  account,
  run,
  onClose,
}: {
  account: AccountView;
  run: Run;
  onClose: () => void;
}) {
  return (
    <ConfirmDialog
      title={`切换到「${account.label}」`}
      confirmLabel="切换"
      onClose={onClose}
      onConfirm={() => run(() => window.factorySwitch.switchTo(account.id))}
    >
      <p>
        将退出
        Factory（正在运行的会话会中断），换入这个账号的凭证后重新打开。
      </p>
    </ConfirmDialog>
  );
}
