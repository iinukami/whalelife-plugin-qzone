/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { account, object, QQError } from './validation.ts';
import type { Interaction, PublishInput, QzoneConfig, SpacePost } from './types.ts';

export const QZONE_LIMITS = { text: 10000, images: 8, bytes: 25 * 1024 * 1024, pixels: 40000000 } as const;
export const defaultConfig: QzoneConfig = { version: 1, enabled: false, visibility: 'public', interactionWhitelist: [] };
export function parseSpaceConfig(raw: unknown): QzoneConfig {
  const v = object(raw);
  if (!Object.keys(v).length) return { ...defaultConfig, interactionWhitelist: [] };
  if (v.version !== 1 || typeof v.enabled !== 'boolean' || v.visibility !== 'public'
    || !Array.isArray(v.interactionWhitelist) || v.interactionWhitelist.length > 1000
    || (v.galleryEnabled !== undefined && typeof v.galleryEnabled !== 'boolean')
    || Object.keys(v).some(k => !['version', 'enabled', 'visibility', 'interactionWhitelist', 'galleryEnabled'].includes(k)))
    throw new QQError('config', '空间配置无效，已停止新动作；请检查设置。');
  return { version: 1, enabled: v.enabled, visibility: 'public', interactionWhitelist: [...new Set(v.interactionWhitelist.map(account))],
    ...(v.galleryEnabled === undefined ? {} : { galleryEnabled: v.galleryEnabled }) };
}
export function stableId(v: unknown): string {
  if (typeof v !== 'string' || !v.trim() || v.length > 128 || /[\u0000-\u001f\u007f]/.test(v))
    throw new QQError('input', '需要不超过 128 字符的稳定动作 ID。');
  return v;
}
export function sessionId(v: unknown): string {
  if (typeof v !== 'string' || !v || v.length > 200 || /[\u0000-\u001f\u007f]/.test(v))
    throw new QQError('session', '缺少可信会话。');
  return v;
}
export function publishInput(raw: unknown): Required<PublishInput> {
  const v = object(raw);
  if (Object.keys(v).some(k => !['actionId', 'content', 'imageIds'].includes(k)) || typeof v.content !== 'string'
    || Array.from(v.content).length > QZONE_LIMITS.text || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v.content))
    throw new QQError('input', '说说参数无效；正文最多 10000 字。');
  const imageIds = v.imageIds ?? [];
  if (!Array.isArray(imageIds) || imageIds.length > QZONE_LIMITS.images || imageIds.some(id => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id))
    || (!v.content.trim() && !imageIds.length)) throw new QQError('input', '需要正文或图库图片 ID；最多 8 张图片。');
  // Mention syntax can trigger an interaction even in one's own post. No implicit mentions.
  if (/@\{|\[CQ:at\b/i.test(v.content)) throw new QQError('mention', '不接受原始提及指令。');
  return { actionId: stableId(v.actionId), content: v.content, imageIds: [...imageIds] };
}
/** Validate direct targets against the CURRENT config and server-derived post metadata. */
export function checkInteraction(post: SpacePost, action: Interaction, config: QzoneConfig) {
  if (!config.enabled || !config.interactionWhitelist.includes(post.authorId)) throw new QQError('whitelist', '互动对象不在空间白名单内。');
  if (!['like', 'comment', 'repost'].includes(action.kind)) throw new QQError('input', '未知互动类型。');
  if (action.kind === 'repost' && post.kind !== 'original') throw new QQError('repost', '只允许转发已确认的原创说说。');
  if (action.reply) {
    if (action.kind !== 'comment' || !config.interactionWhitelist.includes(action.reply.authorId)
      || !post.comments.some(c => c.id === action.reply!.commentId && c.authorId === action.reply!.authorId))
      throw new QQError('whitelist', '回复对象未获授权或无法核实。');
  }
  if ((action.mentions ?? []).some(id => !config.interactionWhitelist.includes(id))) throw new QQError('whitelist', '不能提及白名单外账号。');
  if (action.text !== undefined && (typeof action.text !== 'string' || action.text.length > QZONE_LIMITS.text || /@\{|\[CQ:at\b/i.test(action.text)))
    throw new QQError('mention', '评论内容无效或含原始提及指令。');
}
