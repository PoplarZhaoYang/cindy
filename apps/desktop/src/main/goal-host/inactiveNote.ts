/**
 * 目标模式已不在运行时的状态说明(goal inactive note)。
 *
 * 目标运行期间,每个续跑轮都在 user message 后缀里要求模型"每轮末尾吐 goal_status
 * 裁决块"(见 directive.ts)。目标清除 / 完成 / 暂停 / 受阻后不再追加该指令,但历史
 * 轮次仍留在 agent 原生上下文里,模型会照着自己前面的回复继续吐裁决块,还会以为自己
 * 会被自动续跑,向用户承诺"剩下由我继续处理"。
 *
 * 机制与计划对账(maker-ipc/planReconcile.ts)同一条搭车通道:每次普通发送时现查,
 * 若会话没有 active 目标、而上一条 assistant 回复末尾仍带裁决块,就在 wire payload
 * 前插一段说明。不落库、不新增状态:模型一旦不再吐块,条件自然失效;重启后照样生效。
 * goal controller 自己发起的续跑轮直接走 session.send,不经过这些入口。
 */

import { eq } from 'drizzle-orm';

import { stripGoalVerdictBlock } from '@cindy/maker-shared/goal-verdict';

import { getDbClient } from '../localDb/client/current.js';
import { latestMessageText } from '../localDb/latestMessageText.js';
import { sessionGoals } from '../localDb/schema.js';

/** 与显示层剥离同一判据:只认回复**末尾**的 goal_status / goal_setup 块。 */
export function hasTrailingGoalVerdictBlock(text: string): boolean {
  return text !== '' && stripGoalVerdictBlock(text) !== text;
}

export function shouldPrependGoalInactiveNote(input: {
  goalStatus: string | null;
  latestAssistantText: string;
}): boolean {
  return input.goalStatus !== 'active' && hasTrailingGoalVerdictBlock(input.latestAssistantText);
}

export function buildGoalInactiveNote(): string {
  return [
    '[目标状态]本任务当前没有运行中的目标,之前回复末尾的 goal_status 裁决块只属于目标模式。',
    '本轮回复末尾不要再输出 goal_status 裁决块。',
    '这一轮结束后不会因目标模式被自动唤起继续:可以说明仍在后台运行的进程,但不要承诺会自己接着推进;',
    '需要持续推进时,建议用户开启目标模式或设置自动任务。',
    '== 状态说明结束,以下是用户的新消息 ==',
  ].join('\n');
}

/** 发送入口调用:命中条件返回说明文本,否则 null。读库失败由调用方静默跳过。 */
export async function peekGoalInactiveNote(sessionId: string): Promise<string | null> {
  const [goalRows, latestAssistantText] = await Promise.all([
    getDbClient()
      .drizzle.select({ status: sessionGoals.status })
      .from(sessionGoals)
      .where(eq(sessionGoals.sessionId, sessionId))
      .limit(1),
    latestMessageText(sessionId, 'assistant'),
  ]);
  return shouldPrependGoalInactiveNote({
    goalStatus: goalRows[0]?.status ?? null,
    latestAssistantText,
  })
    ? buildGoalInactiveNote()
    : null;
}
