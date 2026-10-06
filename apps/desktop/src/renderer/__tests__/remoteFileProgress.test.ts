import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadRemoteChatEntry, fetchChatFileWithToasts } from '../lib/remoteFileOpen';
import { getToastSnapshot, toast } from '../lib/toast';
import messages from '../i18n/locales/en/common.json';

vi.mock('@/i18n', () => ({
  i18n: {
    t: (key: string, values: Record<string, unknown> = {}) => {
      const text =
        messages.chat.remoteFile[key.split('.').at(-1)! as keyof typeof messages.chat.remoteFile];
      return (text ?? key).replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(values[name]));
    },
  },
}));

type Progress = Parameters<
  Parameters<Window['electronAPI']['fileBrowser']['onTransferProgress']>[0]
>[0];
const origin = { kind: 'device' as const, deviceId: 'remote-computer' };
// Remote POSIX paths are protocol values, independent of the test host OS.
const workdir = '/remote/project';
const absPath = `${workdir}/file.zip`;
const listeners = new Set<(e: Progress) => void>();
const chatFetch = vi.fn();
const chatDownload = vi.fn();
const success = { ok: true as const, cachePath: '/cache/file.zip', stale: false, size: 4096 };

function deferred<T>() {
  let resolve!: (result: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function emit(
  requestId: string,
  received: number,
  total = 4096,
  phase: Progress['phase'] = 'download',
) {
  for (const listener of listeners)
    listener({ requestId, workdir, relPath: absPath, received, total, phase });
}

const active = () => getToastSnapshot().filter((item) => !item.exiting);

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(performance, 'now').mockImplementation(() => Date.now());
  chatFetch.mockReset();
  chatDownload.mockReset();
  vi.stubGlobal('window', {
    electronAPI: {
      fileBrowser: {
        chatFetch,
        chatDownload,
        onTransferProgress: (listener: (e: Progress) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      showItemInFolder: vi.fn().mockResolvedValue({ success: true }),
    },
  });
});

afterEach(() => {
  toast.dismissAll();
  vi.runAllTimers();
  listeners.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('remote file transfer toasts', () => {
  it('keeps cache hits silent and removes the progress subscription', async () => {
    chatFetch.mockResolvedValue(success);
    await expect(fetchChatFileWithToasts(origin, workdir, absPath)).resolves.toBe(
      success.cachePath,
    );
    await vi.advanceTimersByTimeAsync(600);
    expect(active()).toEqual([]);
    expect(listeners.size).toBe(0);
  });

  it('shows a persistent spinner, updates percentage and measured speed in place, and dismisses on success', async () => {
    const result = deferred<typeof success>();
    chatFetch.mockReturnValue(result.promise);
    const pending = fetchChatFileWithToasts(origin, workdir, absPath);
    const { requestId } = chatFetch.mock.calls[0][0];
    emit(requestId, 0);
    await vi.advanceTimersByTimeAsync(600);
    const first = active()[0];
    expect(first).toMatchObject({ variant: 'loading', duration: 0 });
    expect(first.message).toBe('Downloading… 0% · —');
    await vi.advanceTimersByTimeAsync(400);
    emit(requestId, 2048);
    expect(active()[0]).toMatchObject({ id: first.id, message: 'Downloading… 50% · 2.0 KB/s' });
    result.resolve(success);
    await pending;
    expect(active()).toEqual([]);
    expect(listeners.size).toBe(0);
  });

  it('isolates concurrent requests for the same path on different computers', async () => {
    const a = deferred<typeof success>();
    const b = deferred<typeof success>();
    chatFetch.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const first = fetchChatFileWithToasts(origin, workdir, absPath);
    const second = fetchChatFileWithToasts(
      { kind: 'device', deviceId: 'another-computer' },
      workdir,
      absPath,
    );
    const idA = chatFetch.mock.calls[0][0].requestId;
    const idB = chatFetch.mock.calls[1][0].requestId;
    expect(idA).not.toBe(idB);
    emit(idA, 1024);
    emit(idB, 3072);
    emit('unrelated', 4096);
    await vi.advanceTimersByTimeAsync(600);
    expect(
      active()
        .map((item) => item.message)
        .sort(),
    ).toEqual(['Downloading… 25% · —', 'Downloading… 75% · —']);
    a.resolve(success);
    b.resolve(success);
    await Promise.all([first, second]);
  });

  it('clears the spinner and listener after an IPC failure', async () => {
    const result = deferred<typeof success>();
    chatFetch.mockReturnValue(result.promise);
    const pending = fetchChatFileWithToasts(origin, workdir, absPath);
    await vi.advanceTimersByTimeAsync(600);
    result.reject(new Error('offline'));
    await expect(pending).resolves.toBeNull();
    expect(active()).toHaveLength(1);
    expect(active()[0].variant).toBe('error');
    expect(listeners.size).toBe(0);
  });

  it('keeps stale-copy warnings separate from loading', async () => {
    chatFetch.mockResolvedValue({ ...success, stale: true });
    await fetchChatFileWithToasts(origin, workdir, absPath);
    expect(active()[0]).toMatchObject({
      variant: 'warning',
      message: messages.chat.remoteFile.staleCopy,
    });
  });

  it('shows unknown totals as bytes, resets speed between phases, and keeps packing/extraction distinct', async () => {
    const result = deferred<{ ok: true; path: string; stale: boolean; skipped: number }>();
    chatDownload.mockReturnValue(result.promise);
    const pending = downloadRemoteChatEntry(origin, workdir, absPath);
    const { requestId } = chatDownload.mock.calls[0][0];
    emit(requestId, 1024, 0, 'pack');
    await vi.advanceTimersByTimeAsync(600);
    expect(active()[0].message).toBe('Remote computer is packing… 1.0 KB packed');
    emit(requestId, 0, 4096, 'upload');
    await vi.advanceTimersByTimeAsync(1000);
    emit(requestId, 2048, 4096, 'upload');
    expect(active()[0].message).toBe('Remote computer is uploading… 50% · 2.0 KB/s');
    emit(requestId, 0, 0);
    expect(active()[0].message).toBe('Downloading… 0 B · —');
    await vi.advanceTimersByTimeAsync(1000);
    emit(requestId, 1024, 0);
    expect(active()[0].message).toBe('Downloading… 1.0 KB · 1.0 KB/s');
    emit(requestId, 0, 0, 'extract');
    expect(active()[0].message).toBe('Unpacking…');
    result.resolve({ ok: true, path: '/downloads/file.zip', stale: false, skipped: 0 });
    await pending;
    expect(active()).toEqual([]);
    expect(listeners.size).toBe(0);
  });
});
