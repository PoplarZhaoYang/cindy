import { EventEmitter } from 'node:events';
import { beforeEach, expect, it, vi, type Mock } from 'vitest';

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
type Options = Record<string, unknown> & { width: number; height: number };
interface FakeWindow extends EventEmitter {
  destroyed: boolean;
  options: Options;
  webContents: EventEmitter & { executeJavaScript: Mock };
  setContentProtection: Mock;
  setAlwaysOnTop: Mock;
  getBounds(): Bounds;
  setBounds(bounds: Bounds): void;
  isVisible(): boolean;
}

const state = vi.hoisted(() => ({
  windows: [] as FakeWindow[],
  displays: [] as Array<{ id: number; bounds: Bounds; workArea: Bounds }>,
  events: [] as string[],
  load: null as null | (() => Promise<void>),
  confirm: vi.fn(),
}));
vi.mock('../../i18n', () => ({ t: (key: string) => key }));
vi.mock('../../logger', () => ({ createLogger: () => ({ debug: vi.fn(), warn: vi.fn() }) }));
vi.mock('electron', () => ({
  app: { focus: vi.fn() },
  dialog: { showMessageBox: state.confirm },
  BrowserWindow: class extends EventEmitter {
    id = state.windows.length + 1;
    destroyed = false;
    visible = false;
    options: Options;
    bounds: Bounds;
    webContents = Object.assign(new EventEmitter(), {
      setWindowOpenHandler: vi.fn(),
      executeJavaScript: vi.fn(async (code: string) =>
        code.includes('ByDevice') ? 240 : code.includes('beingControlled') ? 180 : 160,
      ),
    });
    constructor(options: Options) {
      super();
      this.options = options;
      this.bounds = { x: 0, y: 0, width: options.width, height: options.height };
      state.windows.push(this);
    }
    setMenuBarVisibility() {}
    loadURL() {
      return state.load ? state.load() : Promise.resolve();
    }
    setContentProtection = vi.fn();
    setVisibleOnAllWorkspaces = vi.fn();
    setAlwaysOnTop = vi.fn();
    getMediaSourceId() {
      return `window:${100 + this.id}:0`;
    }
    getBounds() {
      return this.bounds;
    }
    setBounds(bounds: Bounds) {
      this.bounds = bounds;
    }
    showInactive() {
      state.events.push(`show:${100 + this.id}`);
      this.visible = true;
    }
    isVisible() {
      return this.visible;
    }
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      this.destroyed = true;
      this.emit('closed');
    }
  },
  screen: Object.assign(new EventEmitter(), {
    getAllDisplays: () => state.displays,
    getPrimaryDisplay: () => state.displays[0],
  }),
  session: {
    fromPartition: () => ({
      setPermissionCheckHandler() {},
      setPermissionRequestHandler() {},
      webRequest: { onBeforeRequest() {} },
    }),
  },
}));

import { screen } from 'electron';
import { ControlledOverlay } from '../controlledOverlay';

const primary = {
  id: 1,
  bounds: { x: 0, y: 0, width: 1440, height: 900 },
  workArea: { x: 0, y: 25, width: 1440, height: 875 },
};
const secondary = {
  id: 2,
  bounds: { x: 1440, y: 0, width: 1920, height: 1080 },
  workArea: { x: 1440, y: 0, width: 1920, height: 1040 },
};
const settle = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
function fixture() {
  const excluded = vi.fn((ids: number[]) => state.events.push(`exclude:${ids.join(',')}`));
  const revoke = vi.fn<(peer: string) => Promise<void>>(async () => {});
  return { overlay: new ControlledOverlay(excluded, revoke), excluded, revoke };
}
const navigate = (window: FakeWindow, url: string) => {
  const event = { url, preventDefault: vi.fn() };
  window.webContents.emit('will-navigate', event);
  return event;
};

beforeEach(() => {
  screen.removeAllListeners();
  state.windows.length = 0;
  state.events.length = 0;
  state.displays = [primary, secondary];
  state.load = null;
  state.confirm.mockReset().mockResolvedValue({ response: 1 });
});

it('filters the overlay from capture before its first visible frame', async () => {
  const { overlay } = fixture();
  overlay.update({ displayId: '1', controlling: false, peer: 'phone' });
  await settle();
  const [window] = state.windows;
  expect(window.options).toMatchObject({
    show: false,
    frame: false,
    transparent: true,
    focusable: false,
    skipTaskbar: true,
    webPreferences: expect.objectContaining({ sandbox: true, contextIsolation: true }),
  });
  expect(window.options.closable).toBeUndefined();
  expect(window.setContentProtection).toHaveBeenCalledWith(true);
  expect(window.setAlwaysOnTop).toHaveBeenCalledWith(true, 'screen-saver');
  expect(state.events).toEqual(['exclude:101', 'show:101']);
  // Measured pill width, centred under the top of the shared display's work area.
  expect(window.getBounds()).toEqual({ x: 640, y: 37, width: 160, height: 28 });
});

it('updates the label in place when control is granted', async () => {
  const { overlay, excluded } = fixture();
  overlay.update({ displayId: '1', controlling: false, peer: 'phone' });
  await settle();
  overlay.update({ displayId: '1', controlling: true, peer: 'phone' });
  await settle();
  expect(state.windows).toHaveLength(1);
  expect(state.windows[0].webContents.executeJavaScript).toHaveBeenLastCalledWith(
    expect.stringContaining('"remoteDesktop.beingControlled"'),
  );
  expect(state.windows[0].getBounds()).toMatchObject({ x: 640, width: 180 });
  expect(excluded).toHaveBeenCalledTimes(1);
});

it('keeps a dragged overlay on the shared display and remembers it for the run', async () => {
  const { overlay } = fixture();
  overlay.update({ displayId: '1', controlling: true, peer: 'phone' });
  await settle();
  const window = state.windows[0];
  window.setBounds({ x: 1400, y: 500, width: 180, height: 28 });
  window.emit('moved');
  expect(window.getBounds()).toEqual({ x: 1260, y: 500, width: 180, height: 28 });
  overlay.update(null);
  overlay.update({ displayId: '1', controlling: true, peer: 'phone' });
  await settle();
  expect(state.windows[1].getBounds()).toEqual({ x: 1260, y: 500, width: 180, height: 28 });
  // A lease on another display starts from that display's default spot.
  overlay.update({ displayId: '2', controlling: true, peer: 'phone' });
  await settle();
  expect(state.windows[1].getBounds()).toEqual({ x: 2310, y: 12, width: 180, height: 28 });
});

it('removes the window and its capture filter when the lease or privacy ends it', async () => {
  const { overlay, excluded } = fixture();
  overlay.update({ displayId: '1', controlling: true, peer: 'phone' });
  await settle();
  overlay.update(null);
  expect(state.windows[0].destroyed).toBe(true);
  expect(excluded).toHaveBeenLastCalledWith([]);
  expect(screen.listenerCount('display-metrics-changed')).toBe(0);
  overlay.update(null);
  expect(excluded).toHaveBeenCalledTimes(2);
});

it('never shows or filters a window whose lease ended while it loaded', async () => {
  let finish!: () => void;
  state.load = () => new Promise<void>((resolve) => (finish = resolve));
  const { overlay, excluded } = fixture();
  overlay.update({ displayId: '1', controlling: false, peer: 'phone' });
  overlay.update(null);
  finish();
  await settle();
  expect(state.windows[0].destroyed).toBe(true);
  expect(state.windows[0].isVisible()).toBe(false);
  expect(excluded).not.toHaveBeenCalledWith([101]);
});

it('drops the filter if the window disappears on its own', async () => {
  const { overlay, excluded } = fixture();
  overlay.update({ displayId: '1', controlling: false, peer: 'phone' });
  await settle();
  state.windows[0].webContents.emit('render-process-gone');
  expect(excluded).toHaveBeenLastCalledWith([]);
  // The next lease transition starts a fresh overlay.
  overlay.update({ displayId: '1', controlling: false, peer: 'phone' });
  await settle();
  expect(state.events.at(-1)).toBe('show:102');
});

it('names the viewing device and ignores unchanged targets', async () => {
  const { overlay } = fixture();
  overlay.update({ displayId: '1', controlling: true, peer: 'phone', name: 'Dash 的 iPhone' });
  await settle();
  const run = state.windows[0].webContents.executeJavaScript;
  expect(run).toHaveBeenLastCalledWith(
    expect.stringContaining('"remoteDesktop.controlledByDevice"'),
  );
  expect(run).toHaveBeenLastCalledWith(expect.stringContaining('"remoteDevice.revokeAccess"'));
  expect(state.windows[0].getBounds()).toMatchObject({ x: 600, width: 240 });
  overlay.update({ displayId: '1', controlling: true, peer: 'phone', name: 'Dash 的 iPhone' });
  await settle();
  expect(run).toHaveBeenCalledTimes(1);
});

it('revokes the shown device only after the local confirmation', async () => {
  const { overlay, revoke } = fixture();
  overlay.update({ displayId: '1', controlling: true, peer: 'phone', name: 'iPhone' });
  await settle();
  const window = state.windows[0];
  state.confirm.mockResolvedValueOnce({ response: 0 });
  expect(
    navigate(window, 'https://cindy-overlay.invalid/revoke').preventDefault,
  ).toHaveBeenCalled();
  await settle();
  expect(revoke).not.toHaveBeenCalled();

  let answer!: (value: { response: number }) => void;
  state.confirm.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
  navigate(window, 'https://cindy-overlay.invalid/revoke');
  // A second click while the dialog is open does not stack another dialog.
  navigate(window, 'https://cindy-overlay.invalid/revoke');
  // The lease moves to another viewer while the dialog is open.
  overlay.update({ displayId: '1', controlling: true, peer: 'laptop', name: 'MacBook' });
  answer({ response: 1 });
  await settle();
  expect(state.confirm).toHaveBeenCalledTimes(2);
  expect(revoke).toHaveBeenCalledExactlyOnceWith('phone');
});

it('cancels every other navigation without acting', async () => {
  const { overlay, revoke } = fixture();
  overlay.update({ displayId: '1', controlling: true, peer: 'phone' });
  await settle();
  expect(navigate(state.windows[0], 'https://example.com/').preventDefault).toHaveBeenCalled();
  await settle();
  expect(state.confirm).not.toHaveBeenCalled();
  expect(revoke).not.toHaveBeenCalled();
});
