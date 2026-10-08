import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const source = readFileSync(new URL('./main.cjs', import.meta.url), 'utf8');

// Exercise the complete probe with an in-memory window and filesystem. The
// baseline is healthy; each fault is injected only after the window recovers.
async function probe(fault) {
  let captures = 0;
  let clicks = 0;
  let report;
  let complete;
  const done = new Promise((resolve) => {
    complete = resolve;
  });
  const contents = {
    id: 1,
    getOSProcessId: () => 2,
    getBackgroundThrottling: () => false,
    setBackgroundThrottling() {},
    on() {},
    focus() {},
    setWindowOpenHandler() {},
    async loadFile() {},
    async executeJavaScript(script) {
      return script.includes('probeFrame') ? { arrived: true } : { clicks };
    },
    async capturePage() {
      captures++;
      if (captures === 2 && fault === 'capture') throw new Error('capture rejected');
      if (captures === 2 && fault === 'timeout') return new Promise(() => {});
      return {
        toPNG: () => Buffer.alloc(1),
        resize() {
          return this;
        },
        toBitmap() {
          if (captures === 2 && fault === 'conversion') throw new Error('conversion failed');
          return Buffer.alloc(1);
        },
      };
    },
    sendInputEvent(event) {
      if (event.type === 'mouseUp') clicks++;
    },
  };
  class Window {
    webContents = contents;
    visible = false;
    show() {
      this.visible = true;
    }
    hide() {
      this.visible = false;
    }
    isVisible() {
      return this.visible;
    }
    isMinimized() {
      return false;
    }
    isFocused() {
      return true;
    }
    isDestroyed() {
      return false;
    }
    on() {}
    focus() {}
    destroy() {}
  }
  const dependencies = {
    electron: {
      app: {
        setPath() {},
        on() {},
        whenReady: () => Promise.resolve(),
        getGPUFeatureStatus: () => ({}),
        exit: (code) => complete({ code, report }),
      },
      BrowserWindow: Window,
    },
    'node:fs': {
      mkdirSync() {},
      appendFileSync() {},
      writeFileSync(file, data) {
        if (file.endsWith('after-idle.png') && fault === 'write') throw new Error('write failed');
        if (file.endsWith('report.json')) report = JSON.parse(data);
      },
    },
    'node:timers/promises': {
      setTimeout: (ms) =>
        ms === 10_000 && !(captures === 2 && fault === 'timeout')
          ? new Promise(() => {})
          : Promise.resolve(),
    },
    './pixels.cjs': {
      inspectPixels: () => ({ pixelsMatch: !(captures === 2 && fault === 'pixels') }),
    },
  };
  vm.runInNewContext(source, {
    require: (name) => dependencies[name] ?? require(name),
    __dirname: path.dirname(fileURLToPath(import.meta.url)),
    process: {
      env: {
        RENDER_PROBE_OUTPUT: 'memory-output',
        RENDER_PROBE_PROFILE: 'memory-profile',
        RENDER_PROBE_IDLE_SECONDS: '1',
        RENDER_PROBE_HIDDEN_SECONDS: '1',
        RENDER_PROBE_SCENARIO: 'hide',
        RENDER_PROBE_SURFACE: 'window',
      },
      versions: {},
      platform: 'win32',
      arch: 'x64',
      on() {},
    },
  });
  return done;
}

describe('render probe evidence classification', () => {
  it.each(['capture', 'timeout', 'conversion', 'write'])(
    'treats %s errors as inconclusive',
    async (fault) => {
      const { code, report } = await probe(fault);
      expect(code).toBe(2);
      expect(report.status).toBe('inconclusive');
      expect(report.error).toBeTruthy();
      expect(report.samples.at(-1).pixelsMatch).toBeUndefined();
    },
  );
  it('fails only when collected pixels mismatch', async () => {
    const { code, report } = await probe('pixels');
    expect(code).toBe(1);
    expect(report.samples.at(-1).pixelsMatch).toBe(false);
  });
  it('passes healthy evidence', async () => {
    expect((await probe()).report.status).toBe('passed');
  });
});
