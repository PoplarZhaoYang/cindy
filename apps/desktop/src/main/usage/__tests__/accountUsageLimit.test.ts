import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  providers: [] as Array<{ id: string; auth: { native?: string } }>,
  codex: vi.fn(),
  claude: vi.fn(),
  xai: vi.fn(),
  accountUsage: vi.fn(),
}));

vi.mock('../../maker-host/active-catalog.js', () => ({
  getActiveCatalog: () => ({ providers: mocks.providers }),
}));
vi.mock('../../usageBroadcaster.js', () => ({
  readCodexAccountUsageSnapshot: mocks.codex,
  readClaudeSubscriptionUsageSnapshot: mocks.claude,
  readXaiSubscriptionUsageSnapshot: mocks.xai,
}));
vi.mock('../subscriptionAccountUsage.js', () => ({
  readSubscriptionAccountUsage: mocks.accountUsage,
}));

import {
  claudeAccountUsageLimit,
  codexAccountUsageLimit,
  readAccountUsageLimit,
  subscriptionFamilyOf,
  xaiAccountUsageLimit,
} from '../accountUsageLimit';

const RESET_5H = 1_791_202_800;
const RESET_WEEK = 1_791_600_000;

beforeEach(() => {
  mocks.providers = [];
  mocks.codex.mockReset();
  mocks.claude.mockReset();
  mocks.xai.mockReset();
  mocks.accountUsage.mockReset();
});

describe('codexAccountUsageLimit', () => {
  it('uses the latest exhausted window across top-level, web and app-server buckets', () => {
    expect(
      codexAccountUsageLimit({
        primary: { usedPercent: 40, resetsAt: RESET_5H },
        webSnapshot: { secondary: { usedPercent: 100, resetsAt: RESET_WEEK } },
        appServerBuckets: { spark: { primary: { usedPercent: 100, resetsAt: RESET_5H } } },
      }),
    ).toEqual({ limited: true, resetAtMs: RESET_WEEK * 1000 });
  });

  it('reports not limited but keeps the latest reset when no window is full', () => {
    expect(
      codexAccountUsageLimit({
        primary: { usedPercent: 40, resetsAt: RESET_5H },
        secondary: { usedPercent: 70, resetsAt: RESET_WEEK },
      }),
    ).toEqual({ limited: false, resetAtMs: RESET_WEEK * 1000 });
  });

  it('honours the upstream reached flag', () => {
    expect(
      codexAccountUsageLimit({
        rateLimitReachedType: 'primary',
        primary: { usedPercent: 99, resetsAt: RESET_5H },
      })?.limited,
    ).toBe(true);
  });
});

describe('claudeAccountUsageLimit', () => {
  it('treats the rejected headers window as exhausted', () => {
    expect(
      claudeAccountUsageLimit({
        fiveHour: { utilization: 92, resetsAt: RESET_5H },
        sevenDay: { utilization: 40, resetsAt: RESET_WEEK },
        rateLimitStatus: 'rejected',
        representativeClaim: 'five_hour',
      }),
    ).toEqual({ limited: true, resetAtMs: RESET_5H * 1000 });
  });

  it('includes model-scoped weekly windows', () => {
    expect(
      claudeAccountUsageLimit({
        fiveHour: { utilization: 10, resetsAt: RESET_5H },
        scoped: [{ utilization: 100, resetsAt: RESET_WEEK, modelDisplayName: 'Opus' }],
      }),
    ).toEqual({ limited: true, resetAtMs: RESET_WEEK * 1000 });
  });
});

describe('xaiAccountUsageLimit', () => {
  it('reads the weekly window', () => {
    expect(xaiAccountUsageLimit({ creditUsagePercent: 100, resetsAt: RESET_WEEK })).toEqual({
      limited: true,
      resetAtMs: RESET_WEEK * 1000,
    });
    expect(xaiAccountUsageLimit({ planLabel: 'SuperGrok' })).toBeNull();
  });
});

describe('subscriptionFamilyOf / readAccountUsageLimit', () => {
  it('maps a provider to its subscription family, independent of the agent', () => {
    mocks.providers = [
      { id: 'openai', auth: { native: 'codex' } },
      { id: 'kimi-coding', auth: {} },
    ];
    expect(subscriptionFamilyOf('claude-code', 'openai')).toBe('codex');
    expect(subscriptionFamilyOf('pi', 'openai')).toBe('codex');
    expect(subscriptionFamilyOf('claude-code', 'kimi-coding')).toBeNull();
    // 旧会话缺省 provider:只有 Codex 能确定是 ChatGPT 默认账号。
    expect(subscriptionFamilyOf('codex', null)).toBe('codex');
    expect(subscriptionFamilyOf('claude-code', null)).toBeNull();
  });

  it('returns undefined for non-subscription providers so callers can use another source', async () => {
    mocks.providers = [{ id: 'kimi-coding', auth: {} }];
    await expect(readAccountUsageLimit('claude-code', 'kimi-coding')).resolves.toBeUndefined();
    expect(mocks.codex).not.toHaveBeenCalled();
  });

  it('reads the ChatGPT snapshot of the session provider', async () => {
    mocks.providers = [{ id: 'codex-work', auth: { native: 'codex' } }];
    mocks.codex.mockResolvedValue({ primary: { usedPercent: 100, resetsAt: RESET_5H } });
    await expect(readAccountUsageLimit('codex', 'codex-work')).resolves.toEqual({
      limited: true,
      resetAtMs: RESET_5H * 1000,
    });
    expect(mocks.codex).toHaveBeenCalledWith('codex-work');
  });

  it('reads independent SuperGrok accounts through the account reader', async () => {
    mocks.providers = [{ id: 'xai-2', auth: { native: 'xai' } }];
    mocks.accountUsage.mockResolvedValue({ creditUsagePercent: 100, resetsAt: RESET_WEEK });
    await expect(readAccountUsageLimit('pi', 'xai-2')).resolves.toEqual({
      limited: true,
      resetAtMs: RESET_WEEK * 1000,
    });
    expect(mocks.xai).not.toHaveBeenCalled();
  });
});
