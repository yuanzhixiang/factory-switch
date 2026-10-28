// 自定义模型价格与模型映射弹窗，移植自 T3 Code（MIT）apps/web/src/components/usage/UsagePriceOverrides.tsx
// 改动：T3 可以同时写多个服务器环境；本应用只有本机一个目标，「应用到」选择器保留但只有本机一项。
import { useEffect, useRef, useState } from "react";
import { isUsagePriceEdit, USAGE_PRICE_FIELDS } from "../../lib/token-usage/price-form";
import {
  isEmptyUsagePriceDraft,
  usageAliasCell,
  usagePriceCell,
  usagePriceTableChanges,
  usagePriceTableErrors,
  type UsagePriceDraft,
  type UsagePriceField,
} from "../../lib/token-usage/price-table";
import {
  writeUsagePrices,
  type UsagePriceTarget,
  type UsagePriceWriteResult,
} from "../../lib/token-usage/price-targets";
import {
  LOCAL_ENVIRONMENT_ID,
  LOCAL_ENVIRONMENT_LABEL,
  loadTokenUsageSettings,
  saveTokenUsageSettings,
  useTokenUsageState,
  type EnvironmentUsageStatus,
} from "../../lib/token-usage/store";
import { Button } from "../shared/Button";
import {
  ChevronDownIcon,
  CloseIcon,
  Dialog,
  Dropdown,
  IconButton,
  MenuCheckboxItem,
  MenuSeparator,
  PlusIcon,
  ResetIcon,
  cn,
} from "./ui";

const MIXED = "不一致";
const UNAVAILABLE = "不可用";

type SaveAttempt = {
  readonly drafts: readonly UsagePriceDraft[];
  readonly destinations: readonly {
    readonly environmentId: string;
    readonly label: string;
  }[];
  readonly results: ReadonlyMap<string, UsagePriceWriteResult | { readonly status: "saving" }>;
};

const CELL_INPUT =
  "h-7 w-full min-w-0 rounded-[2px] border border-border-strong bg-background px-2 text-xs outline-none placeholder:text-muted-foreground focus:border-primary disabled:opacity-40 aria-invalid:border-destructive";

export function UsagePriceOverrides({
  usage,
  initialSelectedEnvironmentIds,
  initialModel,
  onOpenChange,
}: {
  readonly usage: readonly EnvironmentUsageStatus[];
  readonly initialSelectedEnvironmentIds: ReadonlySet<string> | null;
  readonly initialModel?: string | undefined;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const { settings } = useTokenUsageState();
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    loadTokenUsageSettings().catch((error: unknown) =>
      setLoadError(`读取价格设置失败：${String(error)}`),
    );
  }, []);
  const environments: readonly UsagePriceTarget[] = [
    {
      environmentId: LOCAL_ENVIRONMENT_ID,
      label: LOCAL_ENVIRONMENT_LABEL,
      prices: settings?.usagePriceOverrides ?? null,
      aliases: settings?.usageModelAliases ?? null,
      unavailable: settings === null ? (loadError ?? "价格设置还没读取") : null,
    },
  ];
  const [selectedIds, setSelectedIds] = useState(initialSelectedEnvironmentIds);
  const selected = environments.filter(
    (environment) => selectedIds === null || selectedIds.has(environment.environmentId),
  );
  // 设置读到之前无法判断这个模型是否已有自定义价格，等读到后再决定是否预填新行
  const [drafts, setDrafts] = useState<readonly UsagePriceDraft[]>([]);
  const [seeded, setSeeded] = useState(initialModel === undefined);
  if (!seeded && settings !== null) {
    setSeeded(true);
    if (
      initialModel !== undefined &&
      !Object.hasOwn(settings.usagePriceOverrides, initialModel) &&
      !Object.hasOwn(settings.usageModelAliases, initialModel)
    ) {
      setDrafts([{ id: "new:initial", model: initialModel, isNew: true, values: {} }]);
    }
  }
  const [pending, setPending] = useState(false);
  const [attempt, setAttempt] = useState<SaveAttempt | null>(null);
  const focusRowRef = useRef<string | null>(null);
  const nextRowId = useRef(0);
  const customModels = [
    ...new Set(
      selected.flatMap((environment) => [
        ...Object.keys(environment.prices ?? {}),
        ...Object.keys(environment.aliases ?? {}),
      ]),
    ),
  ].sort();
  const models = [
    ...new Set([
      ...customModels,
      ...usage
        .filter((environment) =>
          selected.some((target) => target.environmentId === environment.environmentId),
        )
        .flatMap((environment) => environment.summary?.buckets.map((bucket) => bucket.model) ?? []),
    ]),
  ].sort();
  const newModels = new Set(
    drafts.filter((draft) => draft.isNew).map((draft) => draft.model.trim()),
  );
  const rows: readonly UsagePriceDraft[] = [
    ...customModels
      .filter((model) => attempt === null || !newModels.has(model))
      .map(
        (model) =>
          drafts.find((draft) => draft.id === `model:${model}`) ?? {
            id: `model:${model}`,
            model,
            isNew: false,
            values: {},
          },
      ),
    ...drafts.filter((draft) => draft.isNew),
  ];
  const stagedDrafts = drafts.filter((draft) => !isEmptyUsagePriceDraft(draft));
  const errors = usagePriceTableErrors(selected, stagedDrafts);
  for (const draft of stagedDrafts) {
    if (!draft.isNew) continue;
    if (draft.model.trim() === "") errors.set(draft.id, "请填写模型 ID。");
    else if (
      attempt === null &&
      (customModels.includes(draft.model.trim()) ||
        drafts.some((other) => other.id !== draft.id && other.model.trim() === draft.model.trim()))
    )
      errors.set(draft.id, "这个模型已经有一行了，请在那一行修改。");
  }
  const failedDestinations =
    attempt?.destinations.filter(
      (destination) => attempt.results.get(destination.environmentId)?.status === "failed",
    ) ?? [];
  const locked = pending || failedDestinations.length > 0;
  const hasChanges = stagedDrafts.length > 0;
  const destinationLabel =
    selected.length === 1 ? selected[0]!.label : `${selected.length} 个来源`;
  const selectionLabel = selectedIds === null ? "全部来源" : destinationLabel;
  const discard = () => {
    setDrafts([]);
    setAttempt(null);
  };
  const selectEnvironments = (ids: ReadonlySet<string> | null) => {
    setSelectedIds(ids);
    setAttempt(null);
  };
  const updateDraft = (draft: UsagePriceDraft) => {
    setDrafts((previous) =>
      previous.some((entry) => entry.id === draft.id)
        ? previous.map((entry) => (entry.id === draft.id ? draft : entry))
        : [...previous, draft],
    );
    setAttempt(null);
  };
  const matchesSaved = (
    row: UsagePriceDraft,
    cell: { value: string; placeholder: string },
    value: string,
  ) =>
    !row.isNew &&
    cell.placeholder !== MIXED &&
    cell.placeholder !== UNAVAILABLE &&
    value === cell.value;
  const updateOrDropDraft = (draft: UsagePriceDraft) => {
    if (!draft.isNew && Object.keys(draft.values).length === 0 && draft.alias === undefined)
      setDrafts((previous) => previous.filter((entry) => entry.id !== draft.id));
    else updateDraft(draft);
  };
  const editCell = (row: UsagePriceDraft, field: UsagePriceField, value: string) => {
    const values = { ...row.values, [field]: value };
    const original = usagePriceCell(selected, row.model, field);
    if (matchesSaved(row, original, value)) delete values[field];
    updateOrDropDraft({ ...row, values });
  };
  const editAlias = (row: UsagePriceDraft, value: string) => {
    const { alias: _alias, ...rest } = row;
    void _alias;
    const original = usageAliasCell(selected, row.model);
    updateOrDropDraft(matchesSaved(row, original, value) ? rest : { ...rest, alias: value });
  };
  const save = async (retry = false) => {
    if (pending) return;
    const destinations = retry ? failedDestinations : selected;
    const edits = retry && attempt ? attempt.drafts : stagedDrafts;
    if (destinations.length === 0 || edits.length === 0) return;
    const targets = destinations.map(
      (destination) =>
        environments.find(
          (environment) => environment.environmentId === destination.environmentId,
        ) ?? { ...destination, prices: null, aliases: null, unavailable: "来源已移除" },
    );
    const changes = new Map(
      targets.map((target) => [target.environmentId, usagePriceTableChanges(target, edits)]),
    );
    setPending(true);
    setAttempt((previous) => ({
      drafts: edits,
      destinations: retry && previous ? previous.destinations : targets,
      results: new Map([
        ...(retry && previous ? previous.results : []),
        ...targets.map((target) => [target.environmentId, { status: "saving" } as const] as const),
      ]),
    }));
    let failed = false;
    await writeUsagePrices({
      targets: targets.map((target) => ({
        ...target,
        unavailable:
          target.unavailable ?? [...changes.get(target.environmentId)!.errors.values()][0] ?? null,
      })),
      changes: new Map([...changes].map(([id, plan]) => [id, plan.changes])),
      write: async ({ input }) => {
        await saveTokenUsageSettings(input.patch);
        return { _tag: "Success" };
      },
      onResult: (environmentId, result) => {
        if (result.status === "failed") failed = true;
        setAttempt((previous) =>
          previous === null
            ? null
            : { ...previous, results: new Map(previous.results).set(environmentId, result) },
        );
      },
    });
    setPending(false);
    if (!failed) setDrafts([]);
  };

  return (
    <Dialog
      className="max-w-4xl"
      title="自定义模型价格"
      description="价格和映射对所选来源过去和以后的全部用量生效。"
      onClose={() => {
        if (!pending) onOpenChange(false);
      }}
      footer={
        <>
          <span className="text-xs text-muted-foreground">
            {hasChanges ? `修改将应用到${destinationLabel}` : ""}
          </span>
          <div className="flex flex-wrap justify-end gap-2">
            {hasChanges ? (
              <Button variant="text" disabled={pending} onClick={discard}>
                {failedDestinations.length > 0 ? "放弃未保存的修改" : "放弃修改"}
              </Button>
            ) : null}
            <Button
              variant="primary"
              disabled={
                pending ||
                (!hasChanges && failedDestinations.length === 0) ||
                (failedDestinations.length === 0 && (errors.size > 0 || selected.length === 0))
              }
              onClick={() => void save(failedDestinations.length > 0)}
            >
              {pending ? "正在保存…" : failedDestinations.length > 0 ? "重试失败的保存" : "保存修改"}
            </Button>
          </div>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span id="usage-prices-apply-label" className="shrink-0 text-xs">
              应用到
            </span>
            <Dropdown
              disabled={pending || hasChanges}
              ariaLabel={`应用到：${selectionLabel}`}
              triggerClassName="h-6 border border-border-strong px-2 text-xs hover:border-foreground"
              trigger={() => (
                <>
                  <span className="truncate">{selectionLabel}</span>
                  <ChevronDownIcon className="size-3.5 shrink-0" />
                </>
              )}
            >
              <MenuCheckboxItem
                checked={selectedIds === null}
                onCheckedChange={(checked) => selectEnvironments(checked ? null : new Set())}
              >
                全部来源
              </MenuCheckboxItem>
              <MenuSeparator />
              {environments.map((environment) => (
                <MenuCheckboxItem
                  key={environment.environmentId}
                  checked={selectedIds === null || selectedIds.has(environment.environmentId)}
                  onCheckedChange={(checked) => {
                    const next = new Set(selected.map((target) => target.environmentId));
                    if (checked) next.add(environment.environmentId);
                    else next.delete(environment.environmentId);
                    selectEnvironments(next.size === environments.length ? null : next);
                  }}
                >
                  <span className="flex min-w-0 items-center gap-3">
                    <span className="min-w-0 flex-1 truncate">{environment.label}</span>
                    {environment.unavailable ? (
                      <span className="text-xs text-muted-foreground">
                        {environment.unavailable}
                      </span>
                    ) : null}
                  </span>
                </MenuCheckboxItem>
              ))}
            </Dropdown>
          </div>
          <span className="text-xs text-muted-foreground">美元 / 百万 token</span>
        </div>
        {selected.length === 0 ? (
          <p className="text-xs text-muted-foreground">选择一个来源后查看和修改它的模型价格。</p>
        ) : (
          <>
            <div className="min-w-0 overflow-x-auto rounded-[2px] border border-border">
              <table className="w-full min-w-[720px] table-fixed text-xs" aria-label="自定义模型价格">
                <colgroup>
                  <col className="w-[22%]" />
                  <col className="w-[18%]" />
                  {USAGE_PRICE_FIELDS.map((field) => (
                    <col key={field.key} />
                  ))}
                  <col className="w-10" />
                </colgroup>
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="px-2 py-2 font-normal">模型 ID</th>
                    <th className="px-2 py-2 font-normal">映射到</th>
                    {USAGE_PRICE_FIELDS.map((field) => (
                      <th key={field.key} className="px-2 py-2 font-normal">
                        {field.label}
                      </th>
                    ))}
                    <th className="px-1 py-2">
                      <IconButton
                        aria-label="添加模型价格"
                        title="添加一行"
                        disabled={locked}
                        onClick={() => {
                          const id = `new:${nextRowId.current++}`;
                          focusRowRef.current = id;
                          updateDraft({ id, model: "", isNew: true, values: {} });
                        }}
                      >
                        <PlusIcon />
                      </IconButton>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-2 py-6 text-center text-muted-foreground">
                        {selected.some((environment) => environment.prices === null)
                          ? "部分来源的价格设置不可用。"
                          : "还没有自定义价格或映射，点右上角 + 添加。"}
                      </td>
                    </tr>
                  ) : (
                    rows.map((row) => {
                      const aliasCell = usageAliasCell(selected, row.model);
                      const alias = (row.alias ?? aliasCell.value).trim();
                      return (
                        <tr
                          key={row.id}
                          data-row-id={row.id}
                          className="border-b border-border last:border-b-0 align-top"
                        >
                          <td className="px-2 py-1.5">
                            {row.isNew ? (
                              <input
                                className={CELL_INPUT}
                                value={row.model}
                                ref={(node) => {
                                  if (node && focusRowRef.current === row.id) {
                                    node.focus();
                                    focusRowRef.current = null;
                                  }
                                }}
                                aria-label="新模型 ID"
                                aria-invalid={
                                  (row.model.trim() !== "" && errors.has(row.id)) || undefined
                                }
                                list="usage-price-models"
                                placeholder="模型 ID"
                                autoComplete="off"
                                spellCheck={false}
                                disabled={locked}
                                onChange={(event) =>
                                  updateDraft({ ...row, model: event.target.value })
                                }
                              />
                            ) : (
                              <span
                                className={cn(
                                  "block py-1.5 break-all",
                                  row.removed && "text-muted-foreground line-through",
                                )}
                              >
                                {row.model}
                              </span>
                            )}
                            {errors.has(row.id) &&
                            (row.model.trim() !== "" ||
                              Object.values(row.values).some((value) => value !== "")) ? (
                              <p role="alert" className="mt-1 text-destructive-foreground">
                                {errors.get(row.id)}
                              </p>
                            ) : null}
                          </td>
                          {row.removed ? (
                            <td colSpan={5} className="px-2 py-3 text-muted-foreground">
                              保存后恢复自动定价
                            </td>
                          ) : (
                            <td className="px-2 py-1.5">
                              <input
                                className={CELL_INPUT}
                                value={row.alias ?? aliasCell.value}
                                aria-label={`把 ${row.model || "新模型"} 映射到其他模型`}
                                list="usage-alias-models"
                                placeholder={row.isNew ? "可选" : aliasCell.placeholder}
                                autoComplete="off"
                                spellCheck={false}
                                disabled={locked}
                                onChange={(event) => editAlias(row, event.target.value)}
                              />
                            </td>
                          )}
                          {row.removed ? null : alias !== "" ? (
                            <td colSpan={4} className="px-2 py-3">
                              <span className="break-all text-muted-foreground">
                                按 {alias} 计算
                              </span>
                            </td>
                          ) : (
                            USAGE_PRICE_FIELDS.map((field) => {
                              const cell = usagePriceCell(selected, row.model, field.key);
                              const value = row.values[field.key] ?? (row.isNew ? "" : cell.value);
                              return (
                                <td key={field.key} className="px-2 py-1.5">
                                  <input
                                    className={cn(CELL_INPUT, "font-mono")}
                                    inputMode="decimal"
                                    aria-label={`${row.model || "新模型"}的${field.label}价格`}
                                    value={value}
                                    placeholder={
                                      row.isNew
                                        ? field.optional
                                          ? "同输入价"
                                          : "0.00"
                                        : cell.placeholder
                                    }
                                    autoComplete="off"
                                    disabled={locked}
                                    onChange={(event) => {
                                      if (isUsagePriceEdit(value, event.target.value))
                                        editCell(row, field.key, event.target.value);
                                    }}
                                  />
                                </td>
                              );
                            })
                          )}
                          <td className="px-1 py-1.5">
                            <IconButton
                              disabled={locked}
                              title={
                                row.removed ? "撤销恢复" : row.isNew ? "删除这一行" : "恢复自动定价"
                              }
                              aria-label={
                                row.removed
                                  ? `撤销 ${row.model} 的恢复`
                                  : row.isNew
                                    ? "删除新行"
                                    : `把 ${row.model} 恢复为自动定价`
                              }
                              onClick={() => {
                                if (row.isNew)
                                  setDrafts((previous) =>
                                    previous.filter((entry) => entry.id !== row.id),
                                  );
                                else if (row.removed) updateOrDropDraft({ ...row, removed: false });
                                else updateDraft({ ...row, removed: true });
                              }}
                            >
                              {row.isNew ? <CloseIcon /> : <ResetIcon />}
                            </IconButton>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
            <datalist id="usage-price-models">
              {models
                .filter((model) => !customModels.includes(model))
                .map((model) => (
                  <option key={model} value={model} />
                ))}
            </datalist>
            <datalist id="usage-alias-models">
              {models
                .filter((model) =>
                  selected.every((environment) => !Object.hasOwn(environment.aliases ?? {}, model)),
                )
                .map((model) => (
                  <option key={model} value={model} />
                ))}
            </datalist>
            <p className="text-xs text-muted-foreground">
              缓存价留空时按输入价计算，填 0 表示免费。映射后的模型按它映射到的模型计算用量和价格。
              {selected.length > 1 ? "显示「不一致」的格子在你修改前保留各来源原来的价格。" : ""}
            </p>
          </>
        )}
        {attempt ? (
          <div role="status" className="grid gap-1 text-xs">
            {attempt.destinations.map((destination) => {
              const result = attempt.results.get(destination.environmentId);
              return (
                <div key={destination.environmentId} className="flex justify-between gap-3">
                  <span className="truncate text-muted-foreground">{destination.label}</span>
                  <span
                    className={
                      result?.status === "failed"
                        ? "text-right text-destructive-foreground"
                        : "text-muted-foreground"
                    }
                  >
                    {result?.status === "failed"
                      ? `未保存 · ${result.error}`
                      : result?.status === "saved"
                        ? "已保存"
                        : "正在保存…"}
                  </span>
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
