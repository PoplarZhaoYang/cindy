import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';
import type { InstalledGhost } from '../../../shared/ghost';
import { createGhostComposerListHandler } from '../ghostComposerIpc';
import { ghostComposerListSchema } from '../../../shared/ghostComposer';
import { expandGhostCommand } from '../../../renderer/cindy-brain/ghostCommand';

const mocks = vi.hoisted(() => ({ context: vi.fn(), trusted: vi.fn() }));
vi.mock('../../device-link/invoke-context', () => ({ getDeviceLinkInvokeContext: mocks.context }));
vi.mock('../../security/trustedAppRenderer', () => ({
  assertTrustedAppRendererEvent: mocks.trusted,
}));

const ghost = (id: string): InstalledGhost => ({
  manifest: {
    schemaVersion: 2,
    id,
    name: id,
    version: '1.0.0',
    kind: 'chip',
    entry: 'main.js',
    command: id,
    tools: [{ name: 'draw', description: 'Draw', parameters: { type: 'object' } }],
  },
  dir: '/private/install/path',
  enabled: true,
  approval: { state: 'approved', revision: '00000000-0000-4000-8000-000000000001' },
});
const event = {} as IpcMainInvokeEvent;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.context.mockReturnValue(null);
});

describe('remote composer catalog boundary', () => {
  it('projects public command data with host-side directory disablement', () => {
    const list = vi.fn(() => [ghost('art'), ghost('cindy-mivo'), ghost('xd-mivo')]);
    const disabledIds = vi.fn(() => ['art']);
    mocks.context.mockReturnValue({ channel: 'ghosts:composer-list' });
    const result = createGhostComposerListHandler({ list, disabledIds })(event, '/host/project');
    expect(result.map((item) => item.manifest.id)).toEqual(['art', 'xd-mivo']);
    expect(result[0].enabled).toBe(false);
    expect(disabledIds).toHaveBeenCalledWith('/host/project');
    expect(ghostComposerListSchema.safeParse(result).success).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/private|approval|revision|main.js/);
    const received = ghostComposerListSchema.parse(JSON.parse(JSON.stringify(result)));
    expect(expandGhostCommand('$xd-mivo draw', received)).toContain('ghost_call');
    expect(expandGhostCommand('$art draw', received)).toBe('$art draw');
    expect(mocks.trusted).not.toHaveBeenCalled();
  });

  it('validates local senders and rejects shared-task or mismatched invoke contexts', () => {
    const list = vi.fn(() => [ghost('art')]);
    const handler = createGhostComposerListHandler({ list, disabledIds: () => [] });
    handler(event);
    expect(mocks.trusted).toHaveBeenCalledWith(event);
    list.mockClear();
    for (const context of [
      { channel: 'wrong' },
      { channel: 'ghosts:composer-list', sharedTask: {} },
    ]) {
      mocks.context.mockReturnValue(context);
      expect(() => handler(event)).toThrow();
    }
    expect(list).not.toHaveBeenCalled();
  });

  it.each([null, {}, 42, 'bad\0path', 'x'.repeat(32_769)])(
    'rejects invalid directory arguments',
    (workingDir) => {
      const list = vi.fn(() => []);
      const handler = createGhostComposerListHandler({ list, disabledIds: () => [] });
      expect(() => handler(event, workingDir)).toThrow();
      expect(list).not.toHaveBeenCalled();
    },
  );
});
