import {
  app,
  BrowserWindow,
  dialog,
  nativeTheme,
  screen,
  session,
  type Display,
  type Rectangle,
} from 'electron';
import { createLogger } from '../logger';
import { t } from '../i18n';
import { resolveAppThemeIsDark } from '../resolved-app-theme';
import { readWindowThemeSnapshot } from '../window-theme-mode-store';

const log = createLogger('remote-desktop:overlay');

const HEIGHT = 28;
const FALLBACK_WIDTH = 220;
const TOP_MARGIN = 12;
// Renderer crashes / load failures tolerated per lease before giving up.
const MAX_FAILURES = 3;
// Never loaded: the page has no script, so its only way to talk to Main is
// a link click, which will-navigate cancels and recognizes by this exact URL.
const REVOKE_URL = 'https://cindy-overlay.invalid/revoke';

export interface ControlledOverlayTarget {
  displayId: string;
  controlling: boolean;
  /** Device id of the viewer holding the lease. */
  peer: string;
  name?: string;
}

/** Isolated data page: mirrors surface / border / text / chip-neutral / Thinking Orange tokens (DESIGN.md §2, §10). */
function overlayHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>
:root{color-scheme:light;--surface:#ffffff;--border:#d7d7d4;--text-primary:#262626;--accent:#ea6b17;--chip:#e5e5e5}
:root.dark{color-scheme:dark;--surface:#2c2c2a;--border:#3c3c3a;--text-primary:#d4d4d4;--chip:#3c3c3a}
html,body{margin:0;height:100%;overflow:hidden;background:transparent}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;user-select:none;cursor:default;-webkit-app-region:drag}
main{display:inline-flex;align-items:center;gap:8px;box-sizing:border-box;height:${HEIGHT}px;padding:0 4px 0 12px;border:1px solid var(--border);border-radius:${HEIGHT / 2}px;background:var(--surface);color:var(--text-primary);font-size:12px;white-space:nowrap}
i{flex:none;width:6px;height:6px;border-radius:50%;background:var(--accent);animation:breathe 1.5s ease-in-out infinite}
#text{max-width:260px;overflow:hidden;text-overflow:ellipsis}
a{flex:none;-webkit-app-region:no-drag;display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:10px;background:var(--chip);color:var(--text-primary);text-decoration:none;-webkit-user-drag:none}
a:hover{opacity:.8}
@keyframes breathe{0%,100%{opacity:.3}50%{opacity:1}}
@media(prefers-reduced-motion:reduce){i{animation:none}}
</style></head><body><main><i></i><span id="text"></span><a id="revoke" href="${REVOKE_URL}" draggable="false"></a></main></body></html>`;
}

/** Cindy's selected Light / Dark mode, not just the OS appearance. */
function overlayIsDark(): boolean {
  const theme = readWindowThemeSnapshot();
  return resolveAppThemeIsDark(nativeTheme.shouldUseDarkColors, theme.mode, theme.resolvedIsDark);
}

const UNSAFE_LITERAL_CHARS: Record<string, string> = {
  '<': '\\u003C',
  '>': '\\u003E',
  '/': '\\u002F',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029',
};
/** A JS string literal safe to embed in generated code (device names come from another device). */
function scriptLiteral(value: string): string {
  return JSON.stringify(value).replace(/[<>/\u2028\u2029]/g, (char) => UNSAFE_LITERAL_CHARS[char]);
}

function clamp(bounds: Rectangle, area: Rectangle): Rectangle {
  const x = Math.min(Math.max(bounds.x, area.x), area.x + area.width - bounds.width);
  const y = Math.min(Math.max(bounds.y, area.y), area.y + area.height - bounds.height);
  return { ...bounds, x: Math.round(x), y: Math.round(y) };
}

/** Local-only reminder that this desktop is shared: above every app, draggable,
 * and excluded from what the viewer receives. Frameless and never focused, it
 * has no close affordance; the lease alone decides its lifetime. Its revoke
 * button always asks in a visible system dialog first, so a blind click from
 * the viewer (who cannot see the overlay) cannot revoke anything by itself.
 * (`closable: false` is avoided: on macOS it cancels window-list closes.)
 */
export class ControlledOverlay {
  private window: BrowserWindow | null = null;
  private target: ControlledOverlayTarget | null = null;
  /** The target whose label the page currently shows; revoke acts on this one. */
  private displayed: ControlledOverlayTarget | null = null;
  private failures = 0;
  private rendered = '';
  private loaded = false;
  private placedDisplay: string | null = null;
  private generation = 0;
  private partitionConfigured = false;
  private confirming = false;
  /** Last dragged origin, kept for this app run only. */
  private position: { x: number; y: number } | null = null;

  constructor(
    private readonly excluded: (ids: number[]) => void,
    private readonly revoke: (peer: string) => Promise<void>,
  ) {}

  /** Idempotent; `null` removes the overlay. */
  update(target: ControlledOverlayTarget | null): void {
    if (!target) {
      // A new lease gets a fresh recreation budget.
      this.failures = 0;
      this.stop();
      return;
    }
    this.target = target;
    const window = this.window;
    if (!window) {
      if (this.failures < MAX_FAILURES) void this.create(this.generation + 1);
      return;
    }
    // Until the page loads, create() renders the latest target itself.
    if (this.loaded) void this.render(window, this.generation);
  }

  stop(): void {
    this.generation++;
    this.target = null;
    const window = this.window;
    if (!window) return;
    this.window = null;
    this.displayed = null;
    this.rendered = '';
    this.loaded = false;
    this.placedDisplay = null;
    if (!window.isDestroyed()) window.destroy();
    this.excluded([]);
  }

  private display(): Display {
    return (
      screen.getAllDisplays().find((display) => String(display.id) === this.target?.displayId) ??
      screen.getPrimaryDisplay()
    );
  }

  /** Keeps the overlay on the shared display: the capture filter needs it there. */
  private layout(window: BrowserWindow, width = window.getBounds().width): void {
    const display = this.display();
    const current = window.getBounds();
    let origin = { x: current.x, y: current.y };
    if (this.placedDisplay !== String(display.id)) {
      const remembered = this.position;
      const { bounds, workArea } = display;
      origin =
        remembered &&
        remembered.x >= bounds.x &&
        remembered.y >= bounds.y &&
        remembered.x < bounds.x + bounds.width &&
        remembered.y < bounds.y + bounds.height
          ? remembered
          : {
              x: workArea.x + Math.round((workArea.width - width) / 2),
              y: workArea.y + TOP_MARGIN,
            };
      this.placedDisplay = String(display.id);
    }
    const next = clamp({ ...origin, width, height: HEIGHT }, display.bounds);
    if (
      next.x !== current.x ||
      next.y !== current.y ||
      next.width !== current.width ||
      next.height !== current.height
    )
      window.setBounds(next, false);
  }

  private async render(window: BrowserWindow, generation: number): Promise<void> {
    const target = this.target;
    const controlling = target?.controlling === true;
    const name = target?.name;
    const text = name
      ? t(
          controlling ? 'remoteDesktop.controlledByDevice' : 'remoteDesktop.viewedByDevice',
        ).replaceAll('{{name}}', name)
      : t(controlling ? 'remoteDesktop.beingControlled' : 'remoteDesktop.beingViewed');
    const label = t('remoteDevice.revokeAccess');
    const dark = overlayIsDark();
    const key = JSON.stringify([text, label, dark]);
    if (key === this.rendered) {
      // Same visible label: the shown device is indistinguishable from the target.
      this.displayed = target;
      if (this.placedDisplay !== String(this.display().id)) this.layout(window);
      return;
    }
    this.rendered = key;
    // executeJavaScript calls run in order, so the last size always matches the last text.
    const measured: unknown = await window.webContents
      .executeJavaScript(
        `(() => { document.documentElement.classList.toggle('dark', ${dark});
          document.getElementById('text').textContent = ${scriptLiteral(text)};
          document.getElementById('revoke').textContent = ${scriptLiteral(label)};
          return Math.ceil(document.querySelector('main').getBoundingClientRect().width); })()`,
      )
      .catch(() => null);
    if (generation !== this.generation || window.isDestroyed()) return;
    this.displayed = target;
    const width =
      typeof measured === 'number' && Number.isFinite(measured) && measured > 0
        ? measured
        : FALLBACK_WIDTH;
    this.layout(window, width);
  }

  /** Revokes the device shown when the button was clicked, never a later one. */
  private async confirmRevoke(): Promise<void> {
    const target = this.displayed;
    if (!target || this.confirming) return;
    this.confirming = true;
    try {
      app.focus({ steal: true });
      const { response } = await dialog.showMessageBox({
        type: 'warning',
        message: t('settings.remoteControl.revokeConfirm.title'),
        detail: t('settings.remoteControl.revokeConfirm.description'),
        buttons: [t('privacyExit.cancel'), t('settings.remoteControl.revokeConfirm.confirm')],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (response === 1) await this.revoke(target.peer);
    } catch (error) {
      log.warn('overlay revoke failed', error);
    } finally {
      this.confirming = false;
    }
  }

  private async create(generation: number): Promise<void> {
    this.generation = generation;
    const partition = session.fromPartition('cindy-desktop-overlay', { cache: false });
    if (!this.partitionConfigured) {
      partition.setPermissionCheckHandler(() => false);
      partition.setPermissionRequestHandler((_webContents, _permission, callback) =>
        callback(false),
      );
      partition.webRequest.onBeforeRequest((details, callback) =>
        callback({ cancel: !details.url.startsWith('data:') }),
      );
      this.partitionConfigured = true;
    }
    let window: BrowserWindow;
    try {
      window = new BrowserWindow({
        width: FALLBACK_WIDTH,
        height: HEIGHT,
        show: false,
        // A non-activating panel joins full-screen Spaces without converting
        // the whole app into a UI element (no Dock flicker per session).
        ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
        frame: false,
        transparent: true,
        backgroundColor: '#00000000',
        hasShadow: false,
        roundedCorners: false,
        acceptFirstMouse: true,
        focusable: false,
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        webPreferences: {
          session: partition,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          nodeIntegrationInSubFrames: false,
          nodeIntegrationInWorker: false,
          webSecurity: true,
          allowRunningInsecureContent: false,
          experimentalFeatures: false,
          plugins: false,
          navigateOnDragDrop: false,
          devTools: false,
        },
      });
    } catch (error) {
      log.warn('overlay unavailable', error);
      this.failures++;
      return;
    }
    this.window = window;
    const relayout = () => {
      if (this.window === window && this.loaded && !window.isDestroyed()) this.layout(window);
    };
    screen.on('display-metrics-changed', relayout);
    window.on('moved', () => {
      if (this.window !== window || window.isDestroyed()) return;
      this.layout(window);
      const { x, y } = window.getBounds();
      this.position = { x, y };
    });
    window.on('closed', () => {
      screen.removeListener('display-metrics-changed', relayout);
      if (this.window !== window) return;
      this.window = null;
      this.displayed = null;
      this.rendered = '';
      this.loaded = false;
      this.placedDisplay = null;
      this.excluded([]);
    });
    try {
      window.setMenuBarVisibility(false);
      await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(overlayHtml())}`);
      if (generation !== this.generation || window.isDestroyed()) return;
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', (event) => {
        event.preventDefault();
        if (event.url === REVOKE_URL) void this.confirmRevoke();
      });
      window.webContents.on('render-process-gone', () => {
        this.failures++;
        if (!window.isDestroyed()) window.destroy();
      });
      window.setContentProtection(true);
      window.setVisibleOnAllWorkspaces(true, {
        visibleOnFullScreen: true,
        skipTransformProcessType: true,
      });
      window.setAlwaysOnTop(true, 'screen-saver');
      this.loaded = true;
      await this.render(window, generation);
      if (generation !== this.generation || window.isDestroyed()) return;
      const id = Number(window.getMediaSourceId().split(':')[1]);
      if (!Number.isSafeInteger(id) || id <= 0) throw new Error('overlay window id unavailable');
      // Install the capture filter before the first visible frame.
      this.excluded([id]);
      window.showInactive();
    } catch (error) {
      log.warn('overlay unavailable', error);
      this.failures++;
      if (this.window === window) this.stop();
      else if (!window.isDestroyed()) window.destroy();
    }
  }
}
