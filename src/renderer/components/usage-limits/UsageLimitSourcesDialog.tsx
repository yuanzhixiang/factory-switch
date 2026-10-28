// 额度来源设置：CLIProxyAPI 来源的增删改停用，以及是否允许读取钥匙串里的 Cursor 登录。
// 移植自 T3 Code（MIT）apps/web/src/components/settings/UsageProviderSettings.tsx 与 AddUsageLimitSourceDialog.tsx。
// 改动：T3 放在设置页，这里做成额度页右上角打开的弹窗；T3 只能添加和删除，这里加了编辑和停用。
// management key 只写不读：编辑时留空表示沿用原来的。
import { useState, type ReactNode } from "react";
import type { UsageLimitSourceView } from "../../../shared/usage-limits";
import {
  saveUsageLimitsSettings,
  useUsageLimitsState,
} from "../../lib/usage-limits/store";
import { Button } from "../shared/Button";
import { ConfirmDialog } from "../shared/ConfirmDialog";
import { TextInput } from "../shared/TextInput";
import { Dialog, PlusIcon } from "../token-usage/ui";

/** 按 URL 的主机名生成来源 id，和 T3 一致 */
export function sourceIdFromUrl(url: string): string {
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    // 不是合法 URL 就直接用原文生成
  }
  const slug = host
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `cliproxy-${slug || "hub"}`;
}

/** 开关，对应 T3 的 Switch */
function Switch({
  checked,
  disabled,
  label,
  onChange,
}: {
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly label: string;
  readonly onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-40 ${checked ? "bg-primary" : "bg-track"}`}
    >
      <span
        aria-hidden
        className={`inline-block size-3 rounded-full bg-background transition-transform ${checked ? "translate-x-3.5" : "translate-x-0.5"}`}
      />
    </button>
  );
}

function SettingsRow({
  title,
  description,
  control,
}: {
  readonly title: string;
  readonly description?: ReactNode;
  readonly control?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border py-3 last:border-b-0">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-xs text-foreground">{title}</span>
        {description ? <span className="text-[11px] text-muted-foreground">{description}</span> : null}
      </div>
      {control ? <div className="flex shrink-0 items-center gap-2">{control}</div> : null}
    </div>
  );
}

/** 添加或编辑一个来源；editing 为空表示添加 */
function SourceForm({
  editing,
  onDone,
}: {
  readonly editing: UsageLimitSourceView | null;
  readonly onDone: () => void;
}) {
  const [label, setLabel] = useState(editing?.label ?? "");
  const [url, setUrl] = useState(editing?.url ?? "");
  const [managementKey, setManagementKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmedUrl = url.trim();
  const keyRequired = editing === null || !editing.hasManagementKey;
  const canSave = trimmedUrl.length > 0 && (!keyRequired || managementKey.trim().length > 0);

  const save = async () => {
    if (!canSave || saving) return;
    const id = editing?.id ?? sourceIdFromUrl(trimmedUrl);
    setSaving(true);
    setError(null);
    try {
      await saveUsageLimitsSettings({
        usageLimitSources: {
          [id]: {
            kind: "cliproxy",
            ...(label.trim() ? { label: label.trim() } : {}),
            url: trimmedUrl,
            ...(managementKey.trim() ? { managementKey: managementKey.trim() } : {}),
            enabled: editing?.enabled ?? true,
          },
        },
      });
      onDone();
    } catch (cause) {
      setError(`保存失败：${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-3 rounded-[2px] border border-border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <p className="text-xs text-foreground">
        {editing ? `编辑 ${editing.label?.trim() || editing.url}` : "添加 CLIProxyAPI 来源"}
      </p>
      <p className="text-[11px] text-muted-foreground">
        显示这个来源汇总的每个账号的额度。管理密钥只保存在本机主进程，页面读不到。
      </p>
      <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
        地址
        <TextInput
          placeholder="https://cpa.example.com"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          autoFocus
        />
      </label>
      <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
        管理密钥
        <TextInput
          type="password"
          autoComplete="off"
          placeholder={keyRequired ? "" : "留空则沿用原来的"}
          value={managementKey}
          onChange={(event) => setManagementKey(event.target.value)}
        />
      </label>
      <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
        名称（可选）
        <TextInput
          placeholder="默认用地址的主机名"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
        />
      </label>
      {error ? <p className="text-xs text-destructive-foreground">{error}</p> : null}
      <div className="flex justify-end gap-2">
        <Button onClick={onDone}>取消</Button>
        <Button type="submit" variant="primary" disabled={!canSave || saving}>
          {saving ? "保存中…" : editing ? "保存" : "添加来源"}
        </Button>
      </div>
    </form>
  );
}

export function UsageLimitSourcesDialog({ onClose }: { readonly onClose: () => void }) {
  const { settings } = useUsageLimitsState();
  const [form, setForm] = useState<{ readonly editing: UsageLimitSourceView | null } | null>(
    null,
  );
  const [removing, setRemoving] = useState<UsageLimitSourceView | null>(null);
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = async (patch: Parameters<typeof saveUsageLimitsSettings>[0]) => {
    setUpdating(true);
    setError(null);
    try {
      await saveUsageLimitsSettings(patch);
    } catch (cause) {
      setError(`保存失败：${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setUpdating(false);
    }
  };

  const sources = settings?.usageLimitSources ?? [];
  return (
    <Dialog
      title="额度来源"
      description="本机各家 CLI 的额度会自动读取；这里可以额外接入 CLIProxyAPI 汇总的账号。"
      onClose={onClose}
      className="max-w-xl"
      footer={
        <>
          <span className="text-xs text-destructive-foreground">{error}</span>
          <Button onClick={onClose}>完成</Button>
        </>
      }
    >
      {settings === null ? (
        <p className="text-xs text-muted-foreground">正在读取设置…</p>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col">
            <SettingsRow
              title="Cursor 账号额度"
              description="从 macOS 钥匙串读取已有的 Cursor CLI 登录来查询每月额度，系统可能会弹窗请求授权。"
              control={
                <Switch
                  label="Cursor 账号额度"
                  checked={settings.cursorKeychainUsageEnabled}
                  disabled={updating}
                  onChange={(enabled) => void apply({ cursorKeychainUsageEnabled: enabled })}
                />
              }
            />
          </div>
          <div className="flex flex-col">
            <div className="flex items-center justify-between pb-1">
              <span className="text-xs text-foreground">CLIProxyAPI 来源</span>
              {form === null ? (
                <Button onClick={() => setForm({ editing: null })}>
                  <PlusIcon className="size-3" />
                  添加来源
                </Button>
              ) : null}
            </div>
            {sources.length === 0 ? (
              <SettingsRow title="还没有添加来源。" />
            ) : (
              sources.map((source) => {
                const label = source.label?.trim() || source.url;
                return (
                  <SettingsRow
                    key={source.id}
                    title={label}
                    description={
                      <span className="break-all">
                        CLI Proxy{source.enabled ? "" : " · 已停用"}
                        {source.hasManagementKey ? "" : " · 未设置密钥"}
                        {label !== source.url ? ` · ${source.url}` : ""}
                      </span>
                    }
                    control={
                      <>
                        <Switch
                          label={`${source.enabled ? "停用" : "启用"} ${label}`}
                          checked={source.enabled}
                          disabled={updating}
                          onChange={(enabled) =>
                            void apply({
                              usageLimitSources: {
                                [source.id]: {
                                  kind: source.kind,
                                  ...(source.label ? { label: source.label } : {}),
                                  url: source.url,
                                  enabled,
                                },
                              },
                            })
                          }
                        />
                        <Button variant="text" onClick={() => setForm({ editing: source })}>
                          编辑
                        </Button>
                        <Button variant="text" onClick={() => setRemoving(source)}>
                          删除
                        </Button>
                      </>
                    }
                  />
                );
              })
            )}
          </div>
          {form ? <SourceForm editing={form.editing} onDone={() => setForm(null)} /> : null}
        </div>
      )}
      {removing ? (
        <ConfirmDialog
          title={`删除 ${removing.label?.trim() || removing.url}？`}
          confirmLabel="删除来源"
          danger
          onConfirm={() => void apply({ usageLimitSources: { [removing.id]: null } })}
          onClose={() => setRemoving(null)}
        >
          <p>
            本机保存的管理密钥会一起删除，它的账号不再出现在额度页里；来源服务本身不受影响。
            之后用地址和密钥重新添加即可恢复。
          </p>
        </ConfirmDialog>
      ) : null}
    </Dialog>
  );
}
