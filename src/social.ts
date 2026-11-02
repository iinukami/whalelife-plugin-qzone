/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { mkdir, lstat, readFile, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Context, ToolSession } from 'whalelife';
import { account, object, QQError } from './validation.ts';
import { hash, actionHash } from './store.ts';
import { checkInteraction, sessionId, stableId } from './policy.ts';
import type { ActionKey, Interaction, PostTarget, QQSpaceTransport, QzoneConfig, SocialTransportReceipt } from './types.ts';

interface SocialLedger extends ActionKey {
  version: 1; fingerprint: string; kind: Interaction['kind']; authorId: string; targetTid: string;
  reply?: { commentId: string; authorId: string }; mentions: string[];
  status: 'pending' | SocialTransportReceipt['status']; platformId?: string; platformCode?: number;
  reason?: SocialTransportReceipt['reason'];
  createdAt: string; confirmedAt?: string; historyRecorded: boolean;
}
const response = (v: SocialLedger, duplicate = false, persistenceError = false) => ({
  action: v.kind, actionIdHash: v.actionId, accountId: v.accountId, sessionId: v.sessionId, authorId: v.authorId, targetTid: v.targetTid,
  status: v.status === 'pending' ? 'uncertain' : v.status, confirmed: v.status === 'sent', historyRecorded: v.historyRecorded,
  ...(v.platformId ? { platformId: v.platformId } : {}), ...(Number.isSafeInteger(v.platformCode) ? { platformCode: v.platformCode } : {}), ...(v.reason ? { reason: v.reason } : {}),
  ...(v.kind === 'repost' ? { visibility: 'public' } : {}), duplicate, persistenceError, retryAutomatically: false, canRetry: false,
});
export class Social {
  private ctx: Context;
  private qq: QQSpaceTransport;
  private config: () => QzoneConfig;
  readonly root: string;
  private active = new Map<string, { fingerprint: string; promise: Promise<ReturnType<typeof response>> }>();
  private volatile = new Map<string, SocialLedger>();
  constructor(ctx: Context, qq: QQSpaceTransport, config: () => QzoneConfig, root: string) { this.ctx = ctx; this.qq = qq; this.config = config; this.root = root; }
  private path(key: ActionKey) { return join(this.root, 'social-' + actionHash(key) + '.json'); }
  private async read(key: ActionKey): Promise<SocialLedger | undefined> {
    const live = this.volatile.get(actionHash(key)); if (live) return live;
    let raw: string;
    try {
      const file = this.path(key), stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32768) throw Error();
      raw = await readFile(file, 'utf8');
    } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw new QQError('state', '互动回执无法读取，已阻止重发。'); }
    try {
      const v = JSON.parse(raw) as SocialLedger;
      if (v.version !== 1 || v.accountId !== key.accountId || v.sessionId !== key.sessionId || v.actionId !== key.actionId || !/^[a-f0-9]{64}$/.test(v.fingerprint)
        || !['like', 'comment', 'repost'].includes(v.kind) || !['pending', 'sent', 'not_submitted', 'uncertain'].includes(v.status)
        || typeof v.historyRecorded !== 'boolean' || !/^[1-9]\d{4,19}$/.test(v.authorId) || !/^[\w-]{1,128}$/.test(v.targetTid)
        || (v.status === 'sent' && (v.platformCode !== 0 || (v.kind !== 'like' && (!v.platformId || !/^[\w-]{1,128}$/.test(v.platformId) || v.platformId === '0'))))) throw Error();
      return v;
    } catch { throw new QQError('state', '互动回执损坏，已阻止重发并保留原文件。'); }
  }
  private async save(v: SocialLedger, first = false) {
    await mkdir(this.root, { recursive: true });
    if ((await lstat(this.root)).isSymbolicLink()) throw new QQError('state', '互动回执目录不能是链接。');
    const target = this.path(v), path = first ? target : target + '.' + randomUUID() + '.tmp';
    const file = await open(path, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(v)); await file.sync(); }
    finally { await file.close(); }
    if (!first) { try { await rename(path, target); } finally { await unlink(path).catch(() => {}); } }
  }
  async delivery(input: { actionId: unknown; accountId: unknown }, session: ToolSession) {
    const key = { actionId: hash(stableId(input.actionId)), accountId: account(input.accountId), sessionId: sessionId(session.id) };
    const v = await this.read(key) ?? (/^[a-f0-9]{64}$/.test(String(input.actionId)) ? await this.read({ ...key, actionId: String(input.actionId) }) : undefined);
    return v ? response(v, true, this.volatile.has(actionHash(key))) : { status: 'not_found', confirmed: false, retryAutomatically: false, canRetry: false };
  }
  private validate(post: PostTarget, action: Interaction) {
    if (!post.interactive) throw new QQError('target', '动态作者或类型无法可靠核实，暂不互动。');
    checkInteraction({ ...post, text: '', images: [], hasVideo: false, comments: post.comments.map(c => ({ ...c, text: '' })) }, action, this.config());
    if (action.reply && !post.comments.some(c => c.id === action.reply!.commentId && c.authorId === action.reply!.authorId && c.replyable))
      throw new QQError('reply', '评论层级无法可靠核实，暂不回复。');
  }
  async act(kind: Interaction['kind'], raw: unknown, session: ToolSession) {
    if (session.permission !== 'full') throw new QQError('permission', '空间互动需要完全执行权限。');
    const input = object(raw), sid = sessionId(session.id), actionId = hash(stableId(input.actionId));
    if (Object.keys(input).some(k => !['actionId', 'ref', 'text', 'reply', 'mentions'].includes(k)) || typeof input.ref !== 'string' || input.ref.length > 65536
      || (input.text !== undefined && (typeof input.text !== 'string' || input.text.length > 10000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(input.text)))) throw new QQError('input', '互动参数无效。');
    const action: Interaction = { kind, ...(typeof input.text === 'string' ? { text: input.text } : {}) };
    if (input.reply !== undefined) {
      const r = object(input.reply);
      if (Object.keys(r).some(k => !['commentId', 'authorId'].includes(k)) || typeof r.commentId !== 'string' || !/^[\w-]{1,128}$/.test(r.commentId)) throw new QQError('input', '回复参数无效。');
      action.reply = { commentId: r.commentId, authorId: account(r.authorId) };
    }
    if (input.mentions !== undefined) {
      if (!Array.isArray(input.mentions) || input.mentions.length > 10) throw new QQError('input', '提及参数无效。');
      action.mentions = [...new Set(input.mentions.map(account))];
    }
    if ((kind === 'like' && (input.text !== undefined || input.reply || input.mentions)) || (kind === 'repost' && input.reply)
      || (kind === 'comment' && !action.text?.trim())) throw new QQError('input', '互动正文或类型不匹配。');
    const signal = AbortSignal.any([this.ctx.signal, ...(session.signal ? [session.signal] : [])]); signal.throwIfAborted();
    const identity = await this.qq.qzoneStatus(), key = { accountId: account(identity.accountId), sessionId: sid, actionId };
    // Inspect durable receipts before opening a possibly expired reference. Query remains
    // available after restart; repeating an expired action cannot submit a second request.
    const previous = await this.read(key);
    const same = (v: SocialLedger) => {
      if (hash({ accountId: key.accountId, authorId: v.authorId, tid: v.targetTid, action }) !== v.fingerprint)
        throw new QQError('conflict', '同一动作 ID 的内容发生变化。');
      return response(v, true, this.volatile.has(actionHash(key)));
    };
    if (previous) return same(previous);
    const post = await this.qq.qzoneResolve!({ sessionId: sid, ref: input.ref }, { signal });
    this.validate(post, action);
    if (post.accountId !== key.accountId || !identity.online) throw new QQError('identity', 'QQ 账号或连接已变化。');
    const fingerprint = hash({ accountId: key.accountId, authorId: post.authorId, tid: post.tid, action }), code = actionHash(key);
    const existing = this.active.get(code);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new QQError('conflict', '同一动作 ID 的内容发生变化。');
      return { ...await existing.promise, duplicate: true };
    }
    // read() may have raced a completed action while resolve() crossed the process boundary.
    const raced = await this.read(key); if (raced) return same(raced);
    const again = this.active.get(code);
    if (again) { if (again.fingerprint !== fingerprint) throw new QQError('conflict', '同一动作 ID 的内容发生变化。'); return { ...await again.promise, duplicate: true }; }
    if (this.active.size) throw new QQError('busy', '正在处理另一项空间互动，本次未提交。');
    const promise = this.execute(key, fingerprint, post, action, input.ref, session, signal).finally(() => this.active.delete(code));
    this.active.set(code, { fingerprint, promise }); return promise;
  }
  private async execute(key: ActionKey, fingerprint: string, post: PostTarget, action: Interaction, ref: string, session: ToolSession, signal: AbortSignal) {
    await this.ctx.sessions.context(key.sessionId, session.personaId!); signal.throwIfAborted(); this.validate(post, action);
    const ledger: SocialLedger = { ...key, version: 1, fingerprint, kind: action.kind, authorId: post.authorId, targetTid: post.tid,
      ...(action.reply ? { reply: action.reply } : {}), mentions: action.mentions ?? [], status: 'pending', createdAt: new Date().toISOString(), historyRecorded: false };
    await this.save(ledger, true);
    let entered = false;
    try {
      signal.throwIfAborted(); this.validate(post, action);
      entered = true;
      const result = await this.qq.qzoneInteract!({ sessionId: key.sessionId, ref, action }, { signal });
      if (Number.isSafeInteger(result.platformCode)) ledger.platformCode = result.platformCode;
      if (['platform_rejected', 'missing_receipt', 'response_format', 'transport_failed', 'preflight_rejected'].includes(result.reason ?? '')) ledger.reason = result.reason;
      const hasId = typeof result.platformId === 'string' && /^[\w-]{1,128}$/.test(result.platformId) && result.platformId !== '0';
      if (result.status === 'sent' && result.platformCode === 0 && (action.kind === 'like' || hasId)) {
        ledger.status = 'sent'; ledger.platformCode = 0; if (hasId) ledger.platformId = result.platformId;
        ledger.confirmedAt = new Date().toISOString();
      } else ledger.status = result.status === 'not_submitted' ? 'not_submitted' : 'uncertain';
    } catch { ledger.status = entered ? 'uncertain' : 'not_submitted'; }
    this.volatile.set(actionHash(key), ledger); let persistenceError = false;
    try { await this.save(ledger); } catch { persistenceError = true; }
    if (ledger.status === 'sent') {
      try {
        await this.ctx.memory.recordExperience(key.sessionId, { event_id: 'qzone-social:' + actionHash(key), outcome: 'succeeded', occurred_at: ledger.confirmedAt,
          origin: { platform: 'QQ 空间', action: { like: '点赞', comment: '评论', repost: '转发' }[action.kind] },
          text: `我在 QQ 空间${{ like: '点赞', comment: '评论', repost: '转发' }[action.kind]}了账号 ${post.authorId} 的说说 ${post.tid}。${action.reply ? `回复账号 ${action.reply.authorId} 的评论 ${action.reply.commentId}。` : ''}平台已确认${ledger.platformId ? '，回执 ID：' + ledger.platformId : '（code=0）'}。临时正文不保存。` });
        ledger.historyRecorded = true;
      } catch { /* Confirmation is not undone by a history failure. */ }
      try { await this.save(ledger); } catch { persistenceError = true; }
    }
    if (!persistenceError) this.volatile.delete(actionHash(key));
    return response(ledger, false, persistenceError);
  }
}
