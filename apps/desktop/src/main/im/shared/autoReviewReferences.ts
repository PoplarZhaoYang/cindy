import type { IMMessageEvent } from '@cindy/im';
import {
  projectAutoReviewUserReferences,
  type AutoReviewUserReferences,
} from '@cindy/maker-shared/auto-review-intent';

import type { ImMessageSource } from '../../../shared/imMessageSource';

/**
 * Auto-review references for a personal IM message: only what the user pointed at
 * with this message — its delivered attachments (adapters merge the quoted message's
 * media in) and the message it replies to, both taken from the channel adapter's
 * event. Group background and `contextAttachments` are not pointed at and stay out.
 */
export function imAutoReviewReferences(
  event: Pick<IMMessageEvent, 'attachments' | 'replyContext'>,
): AutoReviewUserReferences | undefined {
  const reply = event.replyContext;
  return projectAutoReviewUserReferences({
    attachments: countAttachments(event.attachments),
    quotedMessages: reply
      ? [
          {
            author: reply.author,
            text: reply.text,
            isBot: reply.isBot,
            attachmentCount: reply.attachmentCount,
          },
        ]
      : [],
  });
}

/**
 * Auto-review references for an official Hook task, from the normalized server
 * TaskSource and the attachments actually delivered. Telegram sends exactly the
 * replied-to message as threadContext; X and Slack send a chain whose last entry is
 * the message being answered, so only that nearest entry counts as pointed at.
 * Servers merge quoted media into the task attachments without a split count.
 */
export function hookAutoReviewReferences(
  source: Pick<ImMessageSource, 'threadContext'> | undefined,
  delivered: { images: number; files: number },
): AutoReviewUserReferences | undefined {
  const nearest = source?.threadContext?.at(-1);
  return projectAutoReviewUserReferences({
    attachments: delivered,
    quotedMessages: nearest
      ? [{ author: nearest.author, text: nearest.text, isBot: nearest.isBot }]
      : [],
  });
}

function countAttachments(attachments: readonly { kind: 'image' | 'file' }[]): {
  images: number;
  files: number;
} {
  const images = attachments.filter((attachment) => attachment.kind === 'image').length;
  return { images, files: attachments.length - images };
}
