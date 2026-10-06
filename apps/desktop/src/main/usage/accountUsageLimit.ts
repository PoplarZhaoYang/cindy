/**
 * 按会话所用订阅账号读「是否已用满 / 何时重置」—— 目标模式与普通任务的限额自动续跑共用。
 *
 * 订阅家族由会话 provider 的 `auth.native` 决定（ChatGPT 订阅不论跑在 Codex、Claude Code
 * bridge 还是 Pi 上都读同一份 ChatGPT 额度）。不是订阅家族的 provider（API key、Coding Plan、
 * Cindy 网关等）返回 `undefined`，由调用方决定是否另有来源；本模块不猜。
 *
 * 快照只是兜底：限额错误自带或文案里写明的重置时刻更准，调用方应优先用那个。
 */

import type { NativeSubscriptionAuth } from '@cindy/model-providers';
import type { ClaudeSubscriptionUsageSnapshot } from '../../shared/claudeSubscriptionUsage.js';
import type { XaiSubscriptionUsageSnapshot } from '../../shared/xaiSubscriptionUsage.js';
import { getActiveCatalog } from '../maker-host/active-catalog.js';
import {
  readClaudeSubscriptionUsageSnapshot,
  readCodexAccountUsageSnapshot,
  readXaiSubscriptionUsageSnapshot,
  type CodexAccountUsagePayload,
  type RateLimitSnapshot,
} from '../usageBroadcaster.js';
import { readSubscriptionAccountUsage } from './subscriptionAccountUsage.js';

export interface AccountUsageLimit {
  /** 快照明确显示某个窗口已用满（或上游标了已触顶）。 */
  limited: boolean;
  /**
   * 重置时刻（unix ms）。有用满的窗口时取其中最晚的；都没用满时取所有窗口里最晚的
   * （宁晚勿早，早醒只会再撞一次）。没有任何带重置时刻的窗口时为 null。
   */
  resetAtMs: number | null;
}

interface UsageWindow {
  usedPercent: number;
  resetsAtSec: number | null | undefined;
}

function fromWindows(windows: readonly UsageWindow[], reachedFlag: boolean): AccountUsageLimit {
  const withReset = windows.filter(
    (w) => typeof w.resetsAtSec === 'number' && Number.isFinite(w.resetsAtSec) && w.resetsAtSec > 0,
  );
  const exhausted = withReset.filter((w) => w.usedPercent >= 100);
  const pool = exhausted.length > 0 ? exhausted : withReset;
  const resetAtSec = pool.length > 0 ? Math.max(...pool.map((w) => w.resetsAtSec as number)) : null;
  return {
    limited: reachedFlag || windows.some((w) => w.usedPercent >= 100),
    resetAtMs: resetAtSec !== null ? resetAtSec * 1000 : null,
  };
}

function codexWindows(snapshot: RateLimitSnapshot | null | undefined): UsageWindow[] {
  if (!snapshot) return [];
  return [snapshot.primary, snapshot.secondary]
    .filter((w): w is NonNullable<typeof w> => !!w && typeof w.usedPercent === 'number')
    .map((w) => ({ usedPercent: w.usedPercent, resetsAtSec: w.resetsAt }));
}

/** ChatGPT 订阅：顶层兼容位、web 槽与 app-server 各桶一起看（限流可能来自任一桶）。 */
export function codexAccountUsageLimit(payload: CodexAccountUsagePayload | null): AccountUsageLimit | null {
  if (!payload) return null;
  const snapshots: RateLimitSnapshot[] = [
    payload,
    ...(payload.webSnapshot ? [payload.webSnapshot] : []),
    ...Object.values(payload.appServerBuckets ?? {}),
  ];
  const windows = snapshots.flatMap(codexWindows);
  if (windows.length === 0) return null;
  return fromWindows(windows, snapshots.some((s) => s.rateLimitReachedType != null));
}

const CLAUDE_REJECTED_CLAIM_TO_WINDOW = {
  five_hour: 'fiveHour',
  seven_day: 'sevenDay',
} as const;

export function claudeAccountUsageLimit(
  snapshot: ClaudeSubscriptionUsageSnapshot | null,
): AccountUsageLimit | null {
  if (!snapshot) return null;
  const windows: UsageWindow[] = [snapshot.fiveHour, snapshot.sevenDay, ...(snapshot.scoped ?? [])]
    .filter((w): w is NonNullable<typeof w> => !!w && typeof w.utilization === 'number')
    .map((w) => ({ usedPercent: w.utilization, resetsAtSec: w.resetsAt }));
  // headers 源被拒时只报状态和「最紧窗口」名，不带用量；把那个窗口视为已用满。
  const rejectedKey =
    snapshot.rateLimitStatus === 'rejected' && snapshot.representativeClaim
      ? CLAUDE_REJECTED_CLAIM_TO_WINDOW[
          snapshot.representativeClaim as keyof typeof CLAUDE_REJECTED_CLAIM_TO_WINDOW
        ]
      : undefined;
  const rejectedWindow = rejectedKey ? snapshot[rejectedKey] : null;
  if (rejectedWindow) windows.push({ usedPercent: 100, resetsAtSec: rejectedWindow.resetsAt });
  if (windows.length === 0) return null;
  return fromWindows(windows, snapshot.rateLimitStatus === 'rejected');
}

/** SuperGrok 只有周窗口。 */
export function xaiAccountUsageLimit(
  snapshot: XaiSubscriptionUsageSnapshot | null,
): AccountUsageLimit | null {
  if (!snapshot || typeof snapshot.creditUsagePercent !== 'number') return null;
  return fromWindows([{ usedPercent: snapshot.creditUsagePercent, resetsAtSec: snapshot.resetsAt }], false);
}

/**
 * 会话所用 provider 属于哪个订阅家族。providerId 缺省（旧会话的隐式默认来源）时只有
 * Codex 能确定是 ChatGPT 默认账号；其它 agent 的默认来源可能是 Cindy 网关，不猜。
 */
export function subscriptionFamilyOf(
  agentKind: string,
  providerId: string | null | undefined,
): NativeSubscriptionAuth | null {
  if (!providerId) return agentKind === 'codex' ? 'codex' : null;
  const provider = getActiveCatalog().providers.find((p) => p.id === providerId);
  return provider?.auth.native ?? null;
}

/**
 * @returns `undefined` = 不是订阅家族（调用方另找来源）；`null` = 是订阅家族但暂无可用快照。
 */
export async function readAccountUsageLimit(
  agentKind: string,
  providerId: string | null | undefined,
): Promise<AccountUsageLimit | null | undefined> {
  const family = subscriptionFamilyOf(agentKind, providerId);
  switch (family) {
    case 'codex':
      return codexAccountUsageLimit(await readCodexAccountUsageSnapshot(providerId ?? undefined));
    case 'claude':
      // 独立 Claude 账号已停用，只有内置默认账号有快照。
      return providerId === 'anthropic' || !providerId
        ? claudeAccountUsageLimit(await readClaudeSubscriptionUsageSnapshot())
        : null;
    case 'xai':
      return xaiAccountUsageLimit(
        !providerId || providerId === 'xai'
          ? await readXaiSubscriptionUsageSnapshot()
          : ((await readSubscriptionAccountUsage(providerId)) as XaiSubscriptionUsageSnapshot | null),
      );
    default:
      return undefined;
  }
}
