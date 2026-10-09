import { useState } from "react";
import type { Run } from "../../lib/run";
import type { AccountView } from "../../lib/accounts";
import { Button } from "../shared/Button";
import { ConfirmDialog } from "../shared/ConfirmDialog";
import { Modal } from "../shared/Modal";
import { Section } from "../shared/Section";
import { TextInput } from "../shared/TextInput";

/** API Key 区块：显示 Key 末四位，可设置、修改、删除 */
export function ApiKeySection({
  account,
  busy,
  run,
}: {
  account: AccountView;
  busy: boolean;
  run: Run;
}) {
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);

  return (
    <Section title="API Key">
      <p className="text-[11px] text-muted-foreground">
        {account.isCurrent
          ? "当前登录的账号直接用本地凭证查询用量。设置 Key 后，切到其他账号时也能继续查这个账号。"
          : "不是当前登录的账号，需要用它的 API Key 查询用量。"}
      </p>
      {!account.isSaved ? (
        <p className="text-muted-foreground">
          先备份这个账号才能设置 API Key。
        </p>
      ) : account.apiKeyHint ? (
        <div className="flex items-center gap-3">
          <span className="font-mono">fk-…{account.apiKeyHint}</span>
          <Button disabled={busy} onClick={() => setEditing(true)}>
            修改
          </Button>
          <Button
            variant="text"
            disabled={busy}
            onClick={() => setRemoving(true)}
          >
            删除
          </Button>
        </div>
      ) : (
        <div>
          <Button disabled={busy} onClick={() => setEditing(true)}>
            设置 API Key
          </Button>
        </div>
      )}

      {editing && (
        <ApiKeyDialog
          label={account.label}
          busy={busy}
          onClose={() => setEditing(false)}
          onSubmit={async (apiKey) => {
            const result = await run(() =>
              window.factorySwitch.setApiKey(account.id, apiKey),
            );
            // 校验通过才关弹窗；失败时留着已粘贴的 Key，方便改正后重试
            if (result?.ok) {
              setEditing(false);
              return null;
            }
            return result?.message ?? "保存失败，请重试。";
          }}
        />
      )}
      {removing && (
        <ConfirmDialog
          title={`删除「${account.label}」的 API Key`}
          confirmLabel="删除"
          danger
          onClose={() => setRemoving(false)}
          onConfirm={() =>
            void run(() => window.factorySwitch.clearApiKey(account.id))
          }
        >
          <p>只删除本程序里保存的 Key，不会在 Factory 后台吊销它。</p>
        </ConfirmDialog>
      )}
    </Section>
  );
}

/** 输入 API Key 的弹窗；保存时主进程会先查一次用量确认 Key 可用 */
function ApiKeyDialog({
  label,
  busy,
  onSubmit,
  onClose,
}: {
  label: string;
  busy: boolean;
  /** 返回错误文案；成功时返回 null */
  onSubmit: (apiKey: string) => Promise<string | null>;
  onClose: () => void;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const trimmed = value.trim();

  return (
    <Modal title={`为「${label}」设置 API Key`} onClose={onClose}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (trimmed && !busy) {
            setError(null);
            void onSubmit(trimmed).then(setError);
          }
        }}
      >
        <p className="text-[11px] text-muted-foreground">
          登录这个账号后，在 app.factory.ai/settings/api-keys 创建。
        </p>
        <TextInput
          autoFocus
          type="password"
          autoComplete="off"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="fk-..."
          className="font-mono"
        />
        {error ? (
          <p className="text-[11px] text-destructive">{error}</p>
        ) : (
          <p className="text-[11px] text-muted-foreground">
            保存前会先查一次用量，确认 Key 可用。
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>取消</Button>
          <Button type="submit" variant="primary" disabled={!trimmed || busy}>
            {busy ? "校验中…" : "保存"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
