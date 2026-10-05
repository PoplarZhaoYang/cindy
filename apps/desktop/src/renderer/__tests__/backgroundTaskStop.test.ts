/**
 * backgroundTaskStop:停止按会话归属路由;远程会话用成功回执收口任务卡,
 * 本机会话不改本地状态(仍由事件流与快照对账收口)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  remote: new Set<string>(),
  devices: new Map<string, string>(),
  stopTask: vi.fn(async () => ({ ok: true as const })),
  stopAll: vi.fn(async () => ({ ok: true as const })),
  settle: vi.fn(),
  running: vi.fn((): ReadonlySet<string> => new Set(['r1', 'r2'])),
}));

vi.mock('@/features/device-link/stickySessionOrigin', () => ({
  getStickySessionDeviceId: (sessionId: string) => mocks.devices.get(sessionId),
}));
vi.mock('@/lib/makerTransport', () => ({
  isRemoteSessionSticky: (sessionId: string) => mocks.remote.has(sessionId),
  stopAgentTaskFor: mocks.stopTask,
  stopSessionBackgroundTasksFor: mocks.stopAll,
}));
vi.mock('@/lib/makerChatStore', () => ({
  makerChatStore: {
    settleStoppedAgentTasks: mocks.settle,
    captureRunningClaudeTaskIds: mocks.running,
  },
}));

import { sharedTaskHostPeer } from '@cindy/device-link';

import {
  canManageBackgroundTasks,
  stopAllBackgroundTasks,
  stopBackgroundTask,
} from '@/lib/backgroundTaskStop';

describe('backgroundTaskStop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.remote = new Set(['remote-s']);
  });

  it('远程会话停止成功后收口对应任务', async () => {
    await stopBackgroundTask('remote-s', 't1');
    expect(mocks.stopTask).toHaveBeenCalledWith('remote-s', 't1');
    expect(mocks.settle).toHaveBeenCalledWith('remote-s', new Set(['t1']));
  });

  it('远程「全部停止」成功后收口该会话所有 running 任务', async () => {
    await stopAllBackgroundTasks('remote-s');
    expect(mocks.stopAll).toHaveBeenCalledWith('remote-s');
    expect(mocks.settle).toHaveBeenCalledWith('remote-s', new Set(['r1', 'r2']));
  });

  it('全部停止在发起前冻结收口集合:回执期间新出现的任务不被误标', async () => {
    mocks.running.mockReturnValueOnce(new Set(['old']));
    mocks.stopAll.mockImplementationOnce(async () => {
      // 回执返回前,会话被别处重启出新任务。
      mocks.running.mockReturnValue(new Set(['old', 'new']));
      return { ok: true as const };
    });
    await stopAllBackgroundTasks('remote-s');
    expect(mocks.settle).toHaveBeenCalledWith('remote-s', new Set(['old']));
  });

  it('本机会话不改本地状态', async () => {
    await stopBackgroundTask('local-s', 't1');
    await stopAllBackgroundTasks('local-s');
    expect(mocks.settle).not.toHaveBeenCalled();
  });

  it('后台任务管理权:本机与同账号远程有,共享任务访客没有', () => {
    mocks.devices = new Map([
      ['remote-s', 'own-device'],
      ['shared-s', sharedTaskHostPeer('m', 'desktop')],
    ]);
    expect(canManageBackgroundTasks('local-s')).toBe(true);
    expect(canManageBackgroundTasks('remote-s')).toBe(true);
    expect(canManageBackgroundTasks('shared-s')).toBe(false);
  });

  it('停止失败时不收口', async () => {
    mocks.stopTask.mockRejectedValueOnce(new Error('[DEVICE_LINK_CHANNEL_NOT_ALLOWED]'));
    await expect(stopBackgroundTask('remote-s', 't1')).rejects.toThrow();
    expect(mocks.settle).not.toHaveBeenCalled();
  });
});
