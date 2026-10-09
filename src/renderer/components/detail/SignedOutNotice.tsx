import { useState } from "react";
import type { Run } from "../../lib/run";
import type { CurrentStatus } from "../../../shared/types";
import { Button } from "../shared/Button";
import { ConfirmDialog } from "../shared/ConfirmDialog";

/** Factory 本地没有可读凭证时的提示条；凭证读不出时允许直接删掉重登 */
export function SignedOutNotice({
  current,
  busy,
  run,
}: {
  current: Exclude<CurrentStatus, { kind: "signed-in" }>;
  busy: boolean;
  run: Run;
}) {
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="flex items-center justify-between gap-4 rounded-[2px] border border-border bg-sidebar px-4 py-3">
      <p className="text-secondary-foreground">
        {current.kind === "signed-out"
          ? "Factory 本地没有登录凭证。在 Factory 里登录后回到这里，备份这个账号。"
          : `读不出 Factory 当前的凭证：${current.message}`}
      </p>
      {current.kind === "unreadable" && (
        <Button
          variant="danger"
          disabled={busy}
          onClick={() => setConfirming(true)}
        >
          删除本地凭证
        </Button>
      )}
      {confirming && (
        <ConfirmDialog
          title="删除本地凭证"
          confirmLabel="删除并打开 Factory"
          danger
          onClose={() => setConfirming(false)}
          onConfirm={() =>
            run(() => window.factorySwitch.deleteLocalCredentials())
          }
        >
          <p>
            凭证会移到 ~/.factory-switch/backups，Factory 重新打开后进入登录页。
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}
