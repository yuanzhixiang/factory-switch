// 移植自 T3 Code（MIT）apps/web/src/components/usage/usagePriceTable.test.ts
// 改动：占位文字和错误提示换成了中文。
import { describe, expect, it } from "vitest";
import {
  usagePriceCell,
  usagePriceTableChanges,
  type UsagePriceDraft,
} from "../../src/renderer/lib/token-usage/price-table";
import type { UsagePriceTarget } from "../../src/renderer/lib/token-usage/price-targets";

const price = { inputCostPerMillionTokens: 2, outputCostPerMillionTokens: 8 };
const target = (
  name: string,
  prices: UsagePriceTarget["prices"],
  aliases: UsagePriceTarget["aliases"] = {},
): UsagePriceTarget => ({
  environmentId: name,
  label: name,
  prices,
  aliases,
  unavailable: null,
});
const draft = (values: UsagePriceDraft["values"]): UsagePriceDraft => ({
  id: "model:example",
  model: "example",
  isNew: false,
  values,
});

describe("price table edits", () => {
  it.each(["constructor", "toString", "__proto__"])(
    "handles an exact model ID named %s",
    (model) => {
      const environment = target("a", {});
      expect(usagePriceCell([environment], model, "inputCostPerMillionTokens")).toEqual({
        value: "",
        placeholder: "自动",
      });
      const result = usagePriceTableChanges(environment, [
        {
          ...draft({ inputCostPerMillionTokens: "2", outputCostPerMillionTokens: "8" }),
          model,
          isNew: true,
        },
      ]);
      expect(result.changes).toEqual([{ model, price }]);
      expect(
        usagePriceCell([target("a", { [model]: price })], model, "inputCostPerMillionTokens").value,
      ).toBe("2");
    },
  );

  it("changes only edited columns while preserving each environment's other prices and models", () => {
    const edits = [draft({ inputCostPerMillionTokens: "3" })];
    const a = usagePriceTableChanges(
      target("a", { example: { ...price, cacheReadCostPerMillionTokens: 0 }, untouched: price }),
      edits,
    );
    const b = usagePriceTableChanges(
      target("b", { example: { ...price, outputCostPerMillionTokens: 10 } }),
      edits,
    );
    expect(a.changes).toEqual([
      {
        model: "example",
        price: { ...price, inputCostPerMillionTokens: 3, cacheReadCostPerMillionTokens: 0 },
      },
    ]);
    expect(b.changes).toEqual([
      { model: "example", price: { inputCostPerMillionTokens: 3, outputCostPerMillionTokens: 10 } },
    ]);
  });

  it("batches new rows and resets, and distinguishes blank cache rates from explicit zero", () => {
    const plan = usagePriceTableChanges(target("a", { example: price }), [
      { ...draft({}), removed: true },
      {
        id: "new:1",
        model: "  vendor/Model  ",
        isNew: true,
        values: {
          inputCostPerMillionTokens: "2",
          outputCostPerMillionTokens: "8",
          cacheReadCostPerMillionTokens: "0",
          cacheWriteCostPerMillionTokens: "",
        },
      },
    ]);
    expect(plan.errors.size).toBe(0);
    expect(plan.changes).toEqual([
      { model: "example", price: null },
      { model: "vendor/Model", price: { ...price, cacheReadCostPerMillionTokens: 0 } },
    ]);
  });

  it("requires complete prices before turning automatic pricing into an override", () => {
    const edits = [draft({ inputCostPerMillionTokens: "3" })];
    expect(usagePriceTableChanges(target("a", { example: price }), edits).errors.size).toBe(0);
    const missing = usagePriceTableChanges(target("b", {}), edits);
    expect(missing.changes).toEqual([]);
    expect(missing.errors.has("model:example")).toBe(true);
  });

  it("mapping a model drops its own price and resetting removes the mapping", () => {
    const priced = target("a", { example: price });
    expect(usagePriceTableChanges(priced, [{ ...draft({}), alias: " example-model " }])).toEqual({
      changes: [
        { model: "example", alias: "example-model" },
        { model: "example", price: null },
      ],
      errors: new Map(),
    });
    const mapped = target("b", {}, { example: "example-model" });
    expect(usagePriceTableChanges(mapped, [{ ...draft({}), removed: true }]).changes).toEqual([
      { model: "example", alias: null },
    ]);
    expect(
      usagePriceTableChanges(mapped, [{ ...draft({}), alias: "example" }]).errors.get(
        "model:example",
      ),
    ).toBe("请映射到另一个模型。");
  });
});
