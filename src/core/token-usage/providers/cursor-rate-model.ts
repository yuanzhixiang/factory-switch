/**
 * Cursor 账单里的模型名换成价格表里的基础模型名，去掉 cursor- 前缀和思考/档位/fast 后缀。
 * Grok 在 xAI 官方价格条目下没有裸名别名，要加 xai/ 前缀。
 * 移植自 T3 Code（MIT）packages/provider-cursor/src/server/accountUsage.ts
 */
export function cursorRateModel(model: string): string {
  const base = model
    .replace(/^cursor-/, "")
    .replace(/(?:-thinking)?(?:-(?:none|minimal|low|medium|high|xhigh|max))?(?:-fast)?$/, "");
  return base.startsWith("grok-") ? `xai/${base}` : base;
}
