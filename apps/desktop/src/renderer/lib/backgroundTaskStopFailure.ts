/**
 * 后台任务停止失败的用户提示(任务卡 / 后台任务面板 / 状态栏共用)。
 *
 * 只对「远程电脑版本过旧,未收录停止 channel」提示升级 —— 这是用户能处理、且重试也不会
 * 变好的情况。其余失败保持静默:状态翻转由事件流 / 快照收口,按钮保留可重试。
 */

import type { TFunction } from 'i18next';

import { extractIpcError } from '@/utils/ipcError';

import { toast } from './toast';

export function reportBackgroundTaskStopFailure(error: unknown, t: TFunction): void {
  if (extractIpcError(error)?.code !== 'DEVICE_LINK_CHANNEL_NOT_ALLOWED') return;
  toast.warning(t('chat.backgroundActivity.remoteStopUnsupported'));
}
