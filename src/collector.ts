/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, open, rename, unlink, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ToolSession } from 'whalelife';
import { account, object, QQError } from './validation.ts';
import { actionHash, hash } from './store.ts';
import { sessionId, stableId } from './policy.ts';
import type { ActionKey, QQSpaceTransport, QzoneConfig, CollectionResult } from './types.ts';
import type { collectionExtension } from './extensions.ts';

interface CollectionLedger extends ActionKey {
  version: 1; refHash: string; index: number; purposes: ('image' | 'meme')[]; fingerprint: string;
  authorId: string; targetTid: string; createdAt: string;
  status: 'pending' | 'saved' | 'uncertain' | 'not_submitted'; assetId?: string; jobId?: string; archived?: boolean;
}
const response = (v: CollectionLedger, duplicate = false, persistenceError = false) => ({
  action: 'collect_image', status: v.status === 'pending' ? 'uncertain' : v.status, confirmed: v.status === 'saved',
  accountId: v.accountId, sessionId: v.sessionId, actionIdHash: v.actionId, authorId: v.authorId, tid: v.targetTid, index: v.index,
  ...(v.assetId ? { assetId: v.assetId, archived: v.archived === true } : {}), ...(v.jobId ? { jobId: v.jobId } : {}),
  duplicate, persistenceError, retryAutomatically: false, canRetry: false,
});
/** Only the explicit collection action may hand selected bytes to a durable gallery.
 * No ref, URL, caption, post body or comment is written into this receipt store. */
export class Collector {
  private active = new Map<string, { fingerprint: string; promise: Promise<ReturnType<typeof response>> }>();
  private volatile = new Map<string, CollectionLedger>();
  private qq: QQSpaceTransport;
  private config: () => QzoneConfig;
  private provider: ReturnType<typeof collectionExtension>;
  readonly root: string;
  constructor(qq: QQSpaceTransport, config: () => QzoneConfig,
    provider: ReturnType<typeof collectionExtension>, root: string) {
    this.qq = qq; this.config = config; this.provider = provider; this.root = root;
  }
  private path(key: ActionKey) { return join(this.root, 'collect-' + actionHash(key) + '.json'); }
  private async read(key: ActionKey): Promise<CollectionLedger | undefined> {
    const live = this.volatile.get(actionHash(key)); if (live) return live;
    let raw: string;
    try { const p = this.path(key), stat = await lstat(p); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192) throw Error(); raw = await readFile(p, 'utf8'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw new QQError('state', '收藏回执无法读取，已停止重复收藏。'); }
    try {
      const v = JSON.parse(raw) as CollectionLedger;
      if (v.version !== 1 || v.accountId !== key.accountId || v.sessionId !== key.sessionId || v.actionId !== key.actionId
        || !/^[a-f0-9]{64}$/.test(v.refHash) || !Number.isInteger(v.index) || v.index < 0 || v.index > 7
        || !Array.isArray(v.purposes) || !v.purposes.length || v.purposes.length > 2 || v.purposes.some(p => !['image', 'meme'].includes(p))
        || v.fingerprint !== hash({ refHash: v.refHash, index: v.index, purposes: v.purposes })
        || !/^[1-9]\d{4,19}$/.test(v.authorId) || !/^[\w-]{1,128}$/.test(v.targetTid)
        || !['pending', 'saved', 'uncertain', 'not_submitted'].includes(v.status)
        || (v.status === 'saved' && (!/^[a-f0-9]{64}$/.test(v.assetId ?? '') || typeof v.archived !== 'boolean'))
        || (v.jobId !== undefined && !/^[\w-]{1,128}$/.test(v.jobId))) throw Error();
      return v;
    } catch { throw new QQError('state', '收藏回执损坏，已停止重复收藏并保留原文件。'); }
  }
  private async save(v: CollectionLedger, first = false) {
    await mkdir(this.root, { recursive: true }); if ((await lstat(this.root)).isSymbolicLink()) throw new QQError('state', '收藏记录目录不能是链接。');
    const target = this.path(v), path = first ? target : target + '.' + randomUUID() + '.tmp';
    const file = await open(path, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(v)); await file.sync(); }
    finally { await file.close(); }
    if (!first) { try { await rename(path, target); } finally { await unlink(path).catch(() => {}); } }
  }
  async delivery(input: { actionId: unknown; accountId: unknown }, session: ToolSession) {
    const key = { actionId: hash(stableId(input.actionId)), accountId: account(input.accountId), sessionId: sessionId(session.id) };
    const v = await this.read(key) ?? (/^[a-f0-9]{64}$/.test(String(input.actionId)) ? await this.read({ ...key, actionId: String(input.actionId) }) : undefined);
    return v ? response(v, true) : { status: 'not_found', confirmed: false, retryAutomatically: false, canRetry: false };
  }
  async collect(raw: unknown, session: ToolSession) {
    if (session.permission !== 'full') throw new QQError('permission', '收藏空间图片需要完全执行权限。');
    const a = object(raw), sid = sessionId(session.id), actionId = hash(stableId(a.actionId));
    if (Object.keys(a).some(k => !['actionId', 'ref', 'index', 'purposes'].includes(k)) || typeof a.ref !== 'string' || a.ref.length > 65536
      || !Number.isInteger(a.index) || Number(a.index) < 0 || Number(a.index) > 7) throw new QQError('input', '收藏图片参数无效。');
    const purposes = a.purposes ?? ['image'];
    if (!Array.isArray(purposes) || !purposes.length || purposes.length > 2 || purposes.some(p => !['image', 'meme'].includes(p))) throw new QQError('input', '收藏用途须为 image 或 meme。');
    const selection = { refHash: hash(a.ref), index: Number(a.index), purposes: [...new Set(purposes)].sort() as ('image' | 'meme')[] };
    const fingerprint = hash(selection), identity = await this.qq.qzoneStatus(), key = { accountId: account(identity.accountId), sessionId: sid, actionId }, code = actionHash(key);
    const existing = this.active.get(code);
    if (existing) { if (existing.fingerprint !== fingerprint) throw new QQError('conflict', '同一收藏动作 ID 的图片或用途不同。'); return { ...await existing.promise, duplicate: true }; }
    if (this.active.size) throw new QQError('busy', '正在收藏另一张空间图片，本次未提交。');
    const run = async () => {
      const previous = await this.read(key);
      if (previous) { if (previous.fingerprint !== fingerprint) throw new QQError('conflict', '同一收藏动作 ID 的图片或用途不同。'); return response(previous, true); }
      const signal = session.signal ?? new AbortController().signal;
      const check = () => { signal.throwIfAborted(); if (!this.config().enabled || this.config().galleryEnabled === false) throw new QQError('disabled', '空间自主使用或图库使用已关闭，未收藏图片。'); if (!this.provider.active()) throw new QQError('extension', '空间图库收藏接入尚未启用。'); };
      check();
      const target = await this.qq.qzoneResolve!({ sessionId: sid, ref: a.ref as string }, { signal }); check();
      if (!identity.online || target.accountId !== key.accountId) throw new QQError('identity', '空间账号已变化，未收藏图片。');
      const image = await this.qq.qzoneReadImage!({ sessionId: sid, ref: a.ref as string, index: selection.index }, { signal }); check();
      const current = await this.qq.qzoneStatus(); if (!current.online || current.accountId !== key.accountId) throw new QQError('identity', '空间账号已变化，未收藏图片。');
      const ledger: CollectionLedger = { ...key, ...selection, fingerprint, version: 1, authorId: target.authorId, targetTid: target.tid, createdAt: new Date().toISOString(), status: 'pending' };
      await this.save(ledger, true); let submitted = false;
      try {
        check(); submitted = true;
        const result = await this.provider.use<Parameters<import('./types.ts').MediaCollector>[0], CollectionResult>({ ...image, purposes: selection.purposes, session: { ...session, id: sid, transientContext: true } }, signal);
        if (result.status === 'saved' && /^[a-f0-9]{64}$/.test(result.assetId ?? '')) {
          ledger.status = 'saved'; ledger.assetId = result.assetId; ledger.archived = result.archived === true;
          if (result.jobId && /^[\w-]{1,128}$/.test(result.jobId)) ledger.jobId = result.jobId;
        } else ledger.status = 'uncertain';
      } catch { ledger.status = submitted ? 'uncertain' : 'not_submitted'; }
      this.volatile.set(code, ledger); let persistenceError = false;
      try { await this.save(ledger); } catch { persistenceError = true; }
      return response(ledger, false, persistenceError);
    };
    const promise = run().finally(() => this.active.delete(code)); this.active.set(code, { fingerprint, promise }); return promise;
  }
}
