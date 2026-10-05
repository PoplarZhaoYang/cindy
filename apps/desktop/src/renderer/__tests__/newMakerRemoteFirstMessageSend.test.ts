import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const source = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'NewMakerDraftRoute.tsx'),
  'utf8',
);

const handoffSource = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'remoteSessionHandoff.ts'),
  'utf8',
);

/**
 * 远程普通首条不能再依赖 SessionView 挂载来补发:用户发送后马上切走,60s 内存 pending
 * 过期,首条丢失,被控端只剩一个空的「未命名任务」。
 */
describe('NewMakerDraftRoute remote first-message send', () => {
  const remoteFence = source.indexOf(
    '远程普通首条在草稿路由直接交给 makerChatStore 的远程发件队列',
  );
  const remoteSend = source.indexOf(
    'makerChatStore.sendMessage(\n                  remoteSessionId,',
    remoteFence,
  );
  const remotePending = source.indexOf('setPending(remoteSessionId, {', remoteFence);
  const remoteNavigate = source.indexOf('navigate(`/cc-agent/${remoteSessionId}`', remoteFence);

  it('hands ordinary remote text to the store outbox before navigating, not to SessionView', () => {
    expect(remoteFence).toBeGreaterThan(-1);
    expect(remoteSend).toBeGreaterThan(remoteFence);
    expect(remoteNavigate).toBeGreaterThan(remoteSend);
    // 视图交接只剩退路:排在直接发送之后。
    expect(remotePending).toBeGreaterThan(remoteSend);
    expect(source.slice(remoteFence, remoteSend)).toContain(
      'deliverRecoverableHandoff(remoteSessionId',
    );
  });

  it('keeps collaboration and slash-command first messages on the SessionView handoff', () => {
    const gate = source.slice(remoteFence, remoteSend);
    expect(gate).toContain('if (!shouldEnableCollab && !remoteSlashFirst && remoteSendWorkingDir)');
    expect(gate).toContain("capabilityAgentKind === 'pi' && !!leadingSlashInvocation(message)");
  });

  it('seeds the chat runtime from the submitted args before the pre-hydration send', () => {
    const seed = source.indexOf('makerChatStore.setSessionRuntime(remoteSessionId, {', remoteFence);
    expect(seed).toBeGreaterThan(remoteFence);
    expect(seed).toBeLessThan(remoteSend);
    const seedBlock = source.slice(seed, source.indexOf('});', seed));
    expect(seedBlock).toContain('agentKind: createArgs.agentKind');
    expect(seedBlock).toContain('sessionProviderId: createArgs.providerId ?? null');
  });

  it('restores an undelivered first message and withdraws both sidebar overlays', () => {
    const failure = source.indexOf('onRemoteOptimisticFailure: (clientId) => {', remoteSend);
    const block = source.slice(failure, remotePending);
    expect(failure).toBeGreaterThan(remoteSend);
    expect(block).toContain('restoreRemoteOptimisticDraft(remoteSessionId, {');
    expect(block).toContain('remoteProjectsStore.clearPendingTitlePreview(remoteSessionId)');
    expect(block).toContain('remoteProjectsStore.clearPendingFirstSend(remoteSessionId)');
  });

  it('marks the first send in the mirror before the provisional row and refresh land', () => {
    const mark = handoffSource.indexOf(
      'remoteProjectsStore.setPendingFirstSend(p.remoteSessionId, p.nowIso)',
    );
    const provisional = handoffSource.indexOf('buildProvisionalRemoteSession({', mark);
    const refresh = handoffSource.indexOf('void refreshRemoteDeviceSessions(', mark);
    expect(mark).toBeGreaterThan(-1);
    expect(provisional).toBeGreaterThan(mark);
    expect(refresh).toBeGreaterThan(mark);
  });
});
