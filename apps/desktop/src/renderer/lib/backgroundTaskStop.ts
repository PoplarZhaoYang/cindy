/**
 * 后台任务停止入口(任务卡 / 后台任务面板 / 状态栏共用)。
 *
 * 执行端按会话归属路由(见 makerTransport 的 stopAgentTaskFor / stopSessionBackgroundTasksFor)。
 * device-link 远程会话停止成功后,用归属端的成功回执收口本地任务卡:镜像终态事件可能在
 * 断连窗口丢失,不收口的话任务会一直显示运行中、停止按钮也不消失。本机会话不在这里改
 * 状态,仍由事件流与快照对账收口。
 */

import { makerChatStore } from './makerChatStore';
import {
  isRemoteSessionSticky,
  stopAgentTaskFor,
  stopSessionBackgroundTasksFor,
} from './makerTransport';

export async function stopBackgroundTask(sessionId: string, taskId: string): Promise<void> {
  await stopAgentTaskFor(sessionId, taskId);
  if (isRemoteSessionSticky(sessionId)) {
    makerChatStore.settleStoppedAgentTasks(sessionId, new Set([taskId]));
  }
}

/** 全部停止:归属端关闭会话进程,该会话所有后台任务随之终止。 */
export async function stopAllBackgroundTasks(sessionId: string): Promise<void> {
  await stopSessionBackgroundTasksFor(sessionId);
  if (isRemoteSessionSticky(sessionId)) {
    makerChatStore.settleStoppedAgentTasks(
      sessionId,
      makerChatStore.captureRunningClaudeTaskIds(sessionId),
    );
  }
}
