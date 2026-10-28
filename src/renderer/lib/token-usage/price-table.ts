// 自定义价格表格的草稿、单元格展示和变更计算，移植自 T3 Code（MIT）apps/web/src/components/usage/usagePriceTable.ts
import {
  parseUsagePriceForm,
  usagePriceForm,
  USAGE_PRICE_FIELDS,
  type UsagePriceForm,
} from "./price-form";
import type { UsagePriceChange, UsagePriceTarget } from "./price-targets";

export type UsagePriceField = (typeof USAGE_PRICE_FIELDS)[number]["key"];

export interface UsagePriceDraft {
  readonly id: string;
  readonly model: string;
  readonly isNew: boolean;
  readonly values: Partial<Pick<UsagePriceForm, UsagePriceField>>;
  /** 编辑后的「映射到」模型；不存在表示保持原映射，空字符串表示删除映射 */
  readonly alias?: string;
  readonly removed?: boolean;
}

export function isEmptyUsagePriceDraft(draft: UsagePriceDraft) {
  return (
    draft.isNew &&
    draft.model.trim() === "" &&
    (draft.alias ?? "").trim() === "" &&
    Object.values(draft.values).every((value) => value.trim() === "")
  );
}

function modelPrice(target: UsagePriceTarget, model: string) {
  return target.prices && Object.hasOwn(target.prices, model) ? target.prices[model] : undefined;
}

function modelAlias(target: UsagePriceTarget, model: string) {
  return target.aliases && Object.hasOwn(target.aliases, model) ? target.aliases[model] : undefined;
}

export function usageAliasCell(targets: readonly UsagePriceTarget[], model: string) {
  if (targets.some((target) => target.aliases === null))
    return { value: "", placeholder: "不可用" };
  const values = targets.map((target) => modelAlias(target, model) ?? "");
  if (values.some((value) => value !== values[0])) return { value: "", placeholder: "不一致" };
  return { value: values[0] ?? "", placeholder: "无" };
}

export function usagePriceCell(
  targets: readonly UsagePriceTarget[],
  model: string,
  field: UsagePriceField,
) {
  const optional = USAGE_PRICE_FIELDS.find((entry) => entry.key === field)!.optional;
  const values = targets.map((target) =>
    modelPrice(target, model) ? usagePriceForm(model, modelPrice(target, model))[field] : null,
  );
  if (targets.some((target) => target.prices === null))
    return { value: "", placeholder: "不可用" };
  if (values.some((value) => value !== values[0])) return { value: "", placeholder: "不一致" };
  return {
    value: values[0] ?? "",
    placeholder: values[0] === null ? "自动" : optional ? "同输入价" : "0.00",
  };
}

export function usagePriceTableChanges(
  target: UsagePriceTarget,
  drafts: readonly UsagePriceDraft[],
) {
  const changes: UsagePriceChange[] = [];
  const errors = new Map<string, string>();
  for (const draft of drafts) {
    if (isEmptyUsagePriceDraft(draft)) continue;
    const model = draft.model.trim();
    const currentAlias = modelAlias(target, model);
    if (draft.removed) {
      if (modelPrice(target, model)) changes.push({ model, price: null });
      if (currentAlias !== undefined) changes.push({ model, alias: null });
      continue;
    }
    const alias = (draft.alias ?? currentAlias ?? "").trim();
    if (alias !== "") {
      if (model === "") errors.set(draft.id, "请填写模型 ID。");
      else if (alias === model) errors.set(draft.id, "请映射到另一个模型。");
      else {
        if (alias !== currentAlias) changes.push({ model, alias });
        if (modelPrice(target, model)) changes.push({ model, price: null });
      }
      continue;
    }
    if (currentAlias !== undefined) {
      changes.push({ model, alias: null });
      if (
        !modelPrice(target, model) &&
        Object.values(draft.values).every((value) => value.trim() === "")
      )
        continue;
    }
    const original = usagePriceForm(model, modelPrice(target, model));
    const form = { ...original, ...draft.values };
    const parsed = parseUsagePriceForm(form);
    if (parsed === null) {
      const missing = USAGE_PRICE_FIELDS.find(
        (field) => !field.optional && form[field.key].trim() === "",
      );
      errors.set(
        draft.id,
        model === ""
          ? "请填写模型 ID。"
          : missing
            ? `${target.label}需要填写${missing.label}价格。`
            : "价格必须是非负数。",
      );
      continue;
    }
    const next = usagePriceForm(model, parsed.price);
    if (USAGE_PRICE_FIELDS.some((field) => original[field.key] !== next[field.key]))
      changes.push(parsed);
  }
  return { changes, errors };
}

export function usagePriceTableErrors(
  targets: readonly UsagePriceTarget[],
  drafts: readonly UsagePriceDraft[],
) {
  return new Map(
    targets
      .filter((target) => target.unavailable === null && target.prices !== null)
      .flatMap((target) => [...usagePriceTableChanges(target, drafts).errors]),
  );
}
