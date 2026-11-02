import type { Context, ToolSession } from 'whalelife';
import { QQError, account } from './validation.ts';
import { publishInput, sessionId, stableId } from './policy.ts';
import { hash, actionHash, ReceiptStore, type Ledger } from './store.ts';
import { validateImages } from './transport.ts';
import type { ActionKey, ImageSnapshot, QQSpaceTransport, QzoneConfig } from './types.ts';
import type { mediaExtension } from './extensions.ts';

export function receipt(v: Ledger, duplicate = false, persistenceError = false) {
  const status = v.status === 'pending' ? 'uncertain' : v.status;
  return { status, confirmed: status === 'sent', accountId: v.accountId, sessionId: v.sessionId, actionId: v.actionId,
    visibility: v.visibility, ...(v.tid ? { tid: v.tid } : {}), historyRecorded: v.historyRecorded,
    duplicate, retryAutomatically: false, canRetry: false, ...(persistenceError ? { persistenceError: true } : {}),
    ...(status === 'uncertain' ? { error: '平台结果不确定，请人工核对；不要更换动作 ID 重发。' } : {}) };
}

export class Publisher {
  private ctx: Context;
  private qq: QQSpaceTransport;
  private config: () => QzoneConfig;
  private media: ReturnType<typeof mediaExtension>;
  readonly store: ReceiptStore;
  private inflight = new Map<string, { fingerprint: string; promise: Promise<ReturnType<typeof receipt>> }>();
  private volatile = new Map<string, Ledger>();
  constructor(ctx: Context, qq: QQSpaceTransport, config: () => QzoneConfig, media: ReturnType<typeof mediaExtension>, store: ReceiptStore) {
    this.ctx = ctx; this.qq = qq; this.config = config; this.media = media; this.store = store;
  }
  async delivery(raw: { actionId: unknown; accountId: unknown }, session: ToolSession) {
    const key = { actionId: stableId(raw.actionId), accountId: account(raw.accountId), sessionId: sessionId(session.id) };
    const hiddenKey = { ...key, actionId: `transient:${hash(key.actionId)}` };
    const v = this.volatile.get(actionHash(key)) ?? await this.store.read(key)
      ?? this.volatile.get(actionHash(hiddenKey)) ?? await this.store.read(hiddenKey);
    return v ? receipt(v, true, this.volatile.has(actionHash(v))) : { status: 'not_found', confirmed: false, retryAutomatically: false, canRetry: false };
  }
  async publish(raw: unknown, session: ToolSession) {
    const input = publishInput(raw), sid = sessionId(session.id);
    if (session.permission !== 'full') throw new QQError('permission', '空间发表需要完全执行权限。');
    const signal = AbortSignal.any([this.ctx.signal, ...(session.signal ? [session.signal] : [])]); signal.throwIfAborted();
    const identity = await this.qq.qzoneStatus();
    const rawKey: ActionKey = { accountId: account(identity.accountId), sessionId: sid, actionId: input.actionId };
    const hiddenKey = { ...rawKey, actionId: `transient:${hash(input.actionId)}` };
    // Preserve legacy keys while ensuring model-copied foreign text cannot enter IDs.
    const hidden = this.volatile.get(actionHash(hiddenKey)) ?? await this.store.read(hiddenKey);
    const ordinary = this.volatile.get(actionHash(rawKey)) ?? await this.store.read(rawKey);
    const key = ordinary ? rawKey : hidden || session.transientContext ? hiddenKey : rawKey;
    const fingerprint = hash({ content: input.content, imageIds: input.imageIds, visibility: 'public' }), code = actionHash(key);
    const active = this.inflight.get(code);
    if (active) {
      if (active.fingerprint !== fingerprint) throw new QQError('conflict', '同一动作 ID 的内容发生变化。');
      return { ...await active.promise, duplicate: true };
    }
    const previous = this.volatile.get(code) ?? await this.store.read(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new QQError('conflict', '同一动作 ID 的内容发生变化。');
      return receipt(previous, true, this.volatile.has(code));
    }
    signal.throwIfAborted();
    // Recheck after asynchronous storage read: concurrent duplicates must share one action.
    const raced = this.inflight.get(code);
    if (raced) {
      if (raced.fingerprint !== fingerprint) throw new QQError('conflict', '同一动作 ID 的内容发生变化。');
      return { ...await raced.promise, duplicate: true };
    }
    if (!this.config().enabled || !identity.online) throw new QQError('disabled', '空间发表未启用或 QQ 不在线。');
    if (this.inflight.size) throw new QQError('busy', '空间正在处理发布，本次未提交。');
    const promise = this.execute(key, fingerprint, input, session, signal).finally(() => this.inflight.delete(code));
    this.inflight.set(code, { fingerprint, promise }); return promise;
  }
  private async execute(key: ActionKey, fingerprint: string, input: ReturnType<typeof publishInput>, session: ToolSession, signal: AbortSignal) {
    let images: ImageSnapshot[] = [];
    if (input.imageIds.length) {
      if (this.config().galleryEnabled === false) throw new QQError('disabled', '空间图库使用已关闭。');
      images = await this.media.use<string[], ImageSnapshot[]>(input.imageIds, signal);
      if (!Array.isArray(images) || images.length !== input.imageIds.length || images.some((p, i) => p.id !== input.imageIds[i]))
        throw new QQError('image', '图库快照与所选图片不一致。');
    }
    const payload = { accountId: key.accountId, content: input.content, images, visibility: 'public' as const };
    await validateImages(payload);
    await this.ctx.sessions.context(key.sessionId, session.personaId!);
    signal.throwIfAborted();
    if (!this.config().enabled) throw new QQError('disabled', '空间发表已关闭，本次未提交。');
    if (images.length && this.config().galleryEnabled === false) throw new QQError('disabled', '空间图库使用已关闭，本次未提交。');
    const identity = await this.qq.qzoneStatus();
    if (!identity.online || identity.accountId !== key.accountId) throw new QQError('identity', 'QQ 账号或连接已变化，本次未提交。');
    const ledger: Ledger = { version: 1, ...key, fingerprint, content: session.transientContext ? '' : input.content,
      ...(session.transientContext ? { contentOmitted: true as const } : {}), visibility: 'public',
      images: images.map(p => ({ id: p.id, mime: p.mime, description: !session.transientContext && typeof p.description === 'string' ? p.description.slice(0, 1000) : '' })),
      status: 'pending', createdAt: new Date().toISOString(), historyRecorded: false };
    await this.store.save(ledger, true);
    let persistenceError = false;
    try {
      // Any failure after entering the RPC may have happened after remote submission.
      signal.throwIfAborted();
      if (!this.config().enabled) throw Error('disabled');
      const r = await this.qq.qzonePublish(payload, { signal });
      if (r.status === 'sent' && typeof r.tid === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(r.tid) && r.tid !== '0') {
        ledger.status = 'sent'; ledger.tid = r.tid; ledger.confirmedAt = new Date().toISOString();
      } else ledger.status = r.status === 'not_submitted' ? 'not_submitted' : 'uncertain';
    } catch { ledger.status = 'uncertain'; }
    // Hold every result until persisted, so a local write failure cannot permit another send.
    this.volatile.set(actionHash(key), ledger);
    try { await this.store.save(ledger); } catch { persistenceError = true; }
    if (ledger.status === 'sent') {
      try {
        await this.ctx.memory.recordExperience(key.sessionId, {
          event_id: `qzone:${actionHash(key)}`, outcome: 'succeeded', occurred_at: ledger.confirmedAt,
          text: `我在 QQ 空间发表了公开说说${ledger.contentOmitted ? '（本轮含临时外部资料，不保存正文）' : '：' + ledger.content.slice(0, 1200)}${images.length ? `；附图库图片 ${images.map(p => p.id).join('、')}` : ''}。说说 ID：${ledger.tid}。`,
          origin: { platform: 'QQ 空间', action: '发表说说' },
        });
        ledger.historyRecorded = true;
      } catch { /* Actual publishing stays sent; never replay to repair history. */ }
      try { await this.store.save(ledger); } catch { persistenceError = true; }
    }
    if (!persistenceError) this.volatile.delete(actionHash(key));
    return receipt(ledger, false, persistenceError);
  }
}
