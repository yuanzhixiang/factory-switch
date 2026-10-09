import type { AppState } from "../../shared/types";

/** 侧边栏和详情页共用的账号视图：已备份账号，加上还没备份的当前账号 */
export interface AccountView {
  id: string;
  label: string;
  email: string | null;
  name: string | null;
  userId: string;
  orgId: string;
  isCurrent: boolean;
  isSaved: boolean;
  savedAt: number | null;
  apiKeyHint: string | null;
}

/** 把状态整理成账号视图列表；没备份的当前账号排在最前 */
export function buildAccountViews(state: AppState): AccountView[] {
  const current = state.current.kind === "signed-in" ? state.current : null;
  const views: AccountView[] = state.accounts.map((account) => ({
    id: account.id,
    label: account.label,
    email: account.email,
    name: account.name,
    userId: account.userId,
    orgId: account.orgId,
    isCurrent: current?.accountId === account.id,
    isSaved: true,
    savedAt: account.savedAt,
    apiKeyHint: state.apiKeyHints[account.id] ?? null,
  }));
  if (current && !current.savedAccountId) {
    views.unshift({
      id: current.accountId,
      label: current.identity.email ?? current.identity.userId,
      email: current.identity.email,
      name: current.identity.name,
      userId: current.identity.userId,
      orgId: current.identity.orgId,
      isCurrent: true,
      isSaved: false,
      savedAt: null,
      apiKeyHint: null,
    });
  }
  return views;
}
