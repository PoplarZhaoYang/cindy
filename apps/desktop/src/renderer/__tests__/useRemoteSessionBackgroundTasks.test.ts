// @vitest-environment jsdom

/**
 * useRemoteSessionBackgroundTasks:远程会话的状态栏后台模式只读被控端快照(不依赖镜像
 * 事件),仅在「在线 + 可见 + 无前台 turn」时读取并定时复查;停止隧道到被控端。
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  devices: [] as Array<{ deviceId: string; connected: boolean }>,
  visible: true,
  activity: vi.fn<(sessionId: string) => Promise<{ active: boolean }>>(async () => ({
    active: false,
  })),
  list: vi.fn<
    (sessionId: string) => Promise<{
      tasks: Array<{ taskId: string; taskType?: string; title?: string; provider?: string }>;
    }>
  >(async () => ({ tasks: [] })),
  stopTask: vi.fn<(sessionId: string, taskId: string) => Promise<{ ok: true }>>(async () => ({
    ok: true,
  })),
  stopAll: vi.fn<(sessionId: string) => Promise<{ ok: true }>>(async () => ({ ok: true })),
  reportFailure: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/features/device-link/remoteProjectsStore', () => ({
  useRemoteDevices: () => mocks.devices,
}));
vi.mock('@/hooks/useWindowVisible', () => ({
  useDocumentVisible: (enabled = true) => enabled && mocks.visible,
}));
vi.mock('@/lib/makerTransport', () => ({
  sessionBackgroundActivityFor: mocks.activity,
  listSessionBackgroundTasksFor: mocks.list,
  stopAgentTaskFor: mocks.stopTask,
  stopSessionBackgroundTasksFor: mocks.stopAll,
}));
vi.mock('@/lib/backgroundTaskStopFailure', () => ({
  reportBackgroundTaskStopFailure: mocks.reportFailure,
}));

import {
  pickRemoteBashTasks,
  useRemoteSessionBackgroundTasks,
} from '@/hooks/useRemoteSessionBackgroundTasks';

async function flush(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

describe('pickRemoteBashTasks', () => {
  it('只取 local_bash 并按 taskId 去重,排除 PI 任务', () => {
    expect(
      pickRemoteBashTasks([
        { taskId: 'b1', taskType: 'local_bash', title: 'pnpm dev' },
        { taskId: 'b1', taskType: 'local_bash' },
        { taskId: 'a1', taskType: 'local_agent' },
        { taskId: 'p1', taskType: 'local_bash', provider: 'pi' },
      ]),
    ).toEqual([{ taskId: 'b1', title: 'pnpm dev' }]);
  });
});

describe('useRemoteSessionBackgroundTasks', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.devices = [{ deviceId: 'dev-1', connected: true }];
    mocks.visible = true;
    mocks.activity.mockResolvedValue({ active: false });
    mocks.list.mockResolvedValue({ tasks: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('本机会话(无 deviceId)不读取', async () => {
    const { result } = renderHook(() => useRemoteSessionBackgroundTasks('s1', undefined, false));
    await flush();
    expect(mocks.activity).not.toHaveBeenCalled();
    expect(result.current.active).toBe(false);
    expect(result.current.tasks).toEqual([]);
  });

  it('在线且空闲时读取被控端快照,并每 15 秒复查', async () => {
    mocks.list.mockResolvedValue({ tasks: [{ taskId: 'b1', taskType: 'local_bash' }] });
    const { result } = renderHook(() => useRemoteSessionBackgroundTasks('s1', 'dev-1', false));
    await flush();
    expect(mocks.activity).toHaveBeenCalledWith('s1');
    expect(result.current.tasks).toEqual([{ taskId: 'b1' }]);

    // 后台活动在 turn 结束宽限期后才亮:靠复查点亮。
    mocks.activity.mockResolvedValue({ active: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(mocks.activity).toHaveBeenCalledTimes(2);
    expect(result.current.active).toBe(true);

    // 任务结束后至多一个周期熄灭。
    mocks.activity.mockResolvedValue({ active: false });
    mocks.list.mockResolvedValue({ tasks: [] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(result.current.active).toBe(false);
    expect(result.current.tasks).toEqual([]);
  });

  it('前台 turn 期间不读取且输出空状态,turn 结束立即重读', async () => {
    mocks.activity.mockResolvedValue({ active: true });
    const { result, rerender } = renderHook(
      ({ running }) => useRemoteSessionBackgroundTasks('s1', 'dev-1', running),
      { initialProps: { running: false } },
    );
    await flush();
    expect(result.current.active).toBe(true);

    rerender({ running: true });
    await flush();
    expect(result.current.active).toBe(false);
    const callsDuringTurn = mocks.activity.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(mocks.activity).toHaveBeenCalledTimes(callsDuringTurn);

    rerender({ running: false });
    await flush();
    expect(mocks.activity).toHaveBeenCalledTimes(callsDuringTurn + 1);
    expect(result.current.active).toBe(true);
  });

  it('设备断连或窗口不可见时不读取', async () => {
    mocks.devices = [{ deviceId: 'dev-1', connected: false }];
    renderHook(() => useRemoteSessionBackgroundTasks('s1', 'dev-1', false));
    await flush();
    expect(mocks.activity).not.toHaveBeenCalled();

    mocks.devices = [{ deviceId: 'dev-1', connected: true }];
    mocks.visible = false;
    renderHook(() => useRemoteSessionBackgroundTasks('s2', 'dev-1', false));
    await flush();
    expect(mocks.activity).not.toHaveBeenCalled();
  });

  it('有模型活动时「全部停止」关闭被控端会话进程,成功后立即熄灭', async () => {
    mocks.activity.mockResolvedValue({ active: true });
    mocks.list.mockResolvedValue({ tasks: [{ taskId: 'b1', taskType: 'local_bash' }] });
    const { result } = renderHook(() => useRemoteSessionBackgroundTasks('s1', 'dev-1', false));
    await flush();
    await act(async () => {
      await result.current.stopAll();
    });
    expect(mocks.stopAll).toHaveBeenCalledWith('s1');
    expect(mocks.stopTask).not.toHaveBeenCalled();
    expect(result.current.active).toBe(false);
    expect(result.current.tasks).toEqual([]);
  });

  it('只有后台命令时逐个精确停止;失败交给统一提示且保留状态', async () => {
    mocks.list.mockResolvedValue({
      tasks: [
        { taskId: 'b1', taskType: 'local_bash' },
        { taskId: 'b2', taskType: 'local_bash' },
      ],
    });
    const failure = new Error('[DEVICE_LINK_CHANNEL_NOT_ALLOWED] maker:agent-task:stop');
    mocks.stopTask.mockRejectedValueOnce(failure);
    const { result } = renderHook(() => useRemoteSessionBackgroundTasks('s1', 'dev-1', false));
    await flush();
    await act(async () => {
      await result.current.stopAll();
    });
    expect(mocks.stopAll).not.toHaveBeenCalled();
    expect(mocks.stopTask).toHaveBeenCalledWith('s1', 'b1');
    expect(mocks.stopTask).toHaveBeenCalledWith('s1', 'b2');
    expect(mocks.reportFailure).toHaveBeenCalledWith(failure, expect.any(Function));
    expect(result.current.tasks).toHaveLength(2);
    expect(result.current.stopping).toBe(false);
  });
});
