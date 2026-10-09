import type { OperationResult } from "../../shared/types";

/** App 传给各组件的操作执行器；出错时结果为 null */
export type Run = (
  operation: () => Promise<OperationResult>,
) => Promise<OperationResult | null>;
