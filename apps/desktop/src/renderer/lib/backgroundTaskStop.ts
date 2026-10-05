/**
 * 后台任务停止入口(任务卡 / 后台任务面板 / 状态栏共用)。
 *
 * 执行端按会话归属路由(见 makerTransport 的 stopAgentTaskFor / stopSessionBackgroundTasksFor)。
 * device-link 远程会话停止成功后,用归属端的成功回执收口本地任务卡:镜像终态事件可能在
 * 断连窗口丢失,不收口的话任务会一直显示运行中、停止按钮也不消失。本机会话不在这里改
 * 状态,仍由事件流与快照对账收口。
 */

import { isSharedTaskPeer } from '@cindy/device-link';

import { getStickySessionDeviceId } from '@/features/device-link/stickySessionOrigin';

import { makerChatStore } from './makerChatStore';
import {
  isRemoteSessionSticky,
  stopAgentTaskFor,
  stopSessionBackgroundTasksFor,
} from './makerTransport';

/**
 * 后台任务管理入口(停止按钮 / 状态栏后台模式)的唯一可见判据:本机会话或同账号
 * 远程会话。共享任务访客看的是房主的任务,后台任务管理权保留给房主
 * (docs/product-rules/shared-task-mode.md),访客白名单也不放行停止通道 —— 不给
 * 入口,避免点了被拒却毫无反馈。
 */
export function canManageBackgroundTasks(sessionId: string): boolean {
  return !isSharedTaskPeer(getStickySessionDeviceId(sessionId) ?? '');
}

export async function stopBackgroundTask(sessionId: string, taskId: string): Promise<void> {
  await stopAgentTaskFor(sessionId, taskId);
  if (isRemoteSessionSticky(sessionId)) {
    makerChatStore.settleStoppedAgentTasks(sessionId, new Set([taskId]));
  }
}

/**
 * 全部停止:归属端关闭会话进程,进程内的 Claude 后台任务随之终止,只收口这些;
 * PI durable 子任务可刻意活过会话进程,不在这里收口。
 */
export async function stopAllBackgroundTasks(sessionId: string): Promise<void> {
  // 发起前冻结待收口集合:回执迟到期间别的控制端重启了会话的话,新任务不在这批里。
  const candidates = makerChatStore.captureRunningClaudeTaskIds(sessionId);
  await stopSessionBackgroundTasksFor(sessionId);
  if (isRemoteSessionSticky(sessionId)) {
    makerChatStore.settleStoppedAgentTasks(sessionId, candidates);
  }
}
