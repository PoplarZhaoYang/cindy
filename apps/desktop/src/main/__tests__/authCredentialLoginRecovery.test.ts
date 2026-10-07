import { readFileSync } from 'node:fs';
import { ScriptTarget, transpileModule } from 'typescript';
import { describe, expect, it, vi } from 'vitest';

// Execute the production login action and eligibility predicate without loading
// Electron or opening a real credential store (same boundary as the wiring tests).
const source = readFileSync(new URL('../authManager.ts', import.meta.url), 'utf8');
const actionSource = source.slice(
  source.indexOf('async function runLoginAction('),
  source.indexOf('export async function dispatchLoginAction('),
);
const eligibilitySource = source.slice(
  source.indexOf('export function needsCredentialProcessRecovery('),
  source.indexOf('/** Prevent automatic process recovery'),
);

function setup({
  backendUnavailable = true,
  authenticated = false,
  passive = false,
  code = 'CREDENTIAL_STORE_UNAVAILABLE',
} = {}) {
  class AuthApiError extends Error {
    statusCode = 503;
    constructor(public code: string) {
      super(code);
    }
  }
  const previous = { step: 'verification-code', kind: 'email', identifier: 'user@example.invalid' };
  const deps = {
    AuthApiError,
    createAuthClient: () => ({ verifyCode: vi.fn(async () => ({ status: 'ok' })) }),
    acceptLoginOutcome: vi.fn(async () => {
      throw new AuthApiError(code);
    }),
    log: { warn: vi.fn() },
    credentialEncryptionUnavailable: backendUnavailable,
    credentialStoreHealth: { unavailable: false },
    accessToken: authenticated ? 'test-only-token' : null,
    getActiveAppSession: () => ({ mode: authenticated ? 'signed-in' : 'signed-out' }),
    isPassiveSharedUserDataInstance: () => passive,
    previous,
  };
  const compiled = transpileModule(
    `
    let loginFlowState = previous;
    let loginFlowEpoch = 1;
    const AUTH_REGION = 'global', activeAuthRealm = 'global';
    let pendingAuthRealm = null;
    const providerConfig = {};
    ${actionSource}
    ${eligibilitySource.replace('export function', 'function')}
    return { run: runLoginAction, needsRecovery: needsCredentialProcessRecovery };
  `,
    { compilerOptions: { target: ScriptTarget.ES2022 } },
  ).outputText;
  return { ...new Function(...Object.keys(deps), compiled)(...Object.values(deps)), previous };
}

describe('credential failure during fresh sign-in', () => {
  it.each([
    { backendUnavailable: true, authenticated: false, passive: false, recovery: true },
    { backendUnavailable: false, authenticated: false, passive: false, recovery: false },
    { backendUnavailable: true, authenticated: true, passive: false, recovery: false },
    { backendUnavailable: true, authenticated: false, passive: true, recovery: false },
  ])(
    'shows recovery guidance without restarting unsafe or irrelevant cases: %j',
    async ({ recovery, ...options }) => {
      const harness = setup(options);
      expect(harness.needsRecovery()).toBe(false);
      const result = await harness.run({
        type: 'verify-code',
        kind: 'email',
        identifier: 'user@example.invalid',
        code: '123456',
      });
      expect(result).toEqual({
        success: false,
        code: 'CREDENTIAL_STORE_UNAVAILABLE',
        state: { step: 'error', code: 'CREDENTIAL_STORE_UNAVAILABLE', recoverTo: 'identifier' },
      });
      expect(harness.needsRecovery()).toBe(recovery);
    },
  );

  it.each(['INVALID_CODE', 'NETWORK_ERROR'])(
    'keeps the form for %s without requesting process recovery',
    async (code) => {
      const harness = setup({ code });
      const result = await harness.run({
        type: 'verify-code',
        kind: 'email',
        identifier: 'user@example.invalid',
        code: '123456',
      });
      expect(result.state).toBe(harness.previous);
      expect(harness.needsRecovery()).toBe(false);
    },
  );
});
