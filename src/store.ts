/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, open, rename, unlink, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ActionKey } from './types.ts';
import { QQError } from './validation.ts';

export const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
export const actionHash = (key: ActionKey) => hash([key.accountId, key.sessionId, key.actionId]);
export interface Ledger extends ActionKey {
  version: 1; fingerprint: string; content: string; contentOmitted?: true; visibility: 'public';
  images: { id: string; mime: string; description: string }[];
  status: 'pending' | 'sent' | 'uncertain' | 'not_submitted';
  createdAt: string; tid?: string; confirmedAt?: string; historyRecorded: boolean;
}
/** Business receipts in this plugin's own data directory. Malformed JSON is never absence. */
export class ReceiptStore {
  readonly root: string;
  constructor(root: string) { this.root = root; }
  private path(key: ActionKey) { return join(this.root, `action-${actionHash(key)}.json`); }
  async read(key: ActionKey): Promise<Ledger | undefined> {
    const path = this.path(key);
    let raw: string;
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) throw Error('state');
      raw = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new QQError('state', '空间回执不可读取，已阻止重发并保留原文件。');
    }
    try {
      const v = JSON.parse(raw) as Ledger;
      if (v.version !== 1 || v.accountId !== key.accountId || v.sessionId !== key.sessionId || v.actionId !== key.actionId
        || !/^[a-f0-9]{64}$/.test(v.fingerprint) || typeof v.content !== 'string' || v.visibility !== 'public'
        || !Array.isArray(v.images) || v.images.some(p => !/^[a-f0-9]{64}$/.test(p.id) || typeof p.description !== 'string')
        || !['pending', 'sent', 'uncertain', 'not_submitted'].includes(v.status) || typeof v.historyRecorded !== 'boolean'
        || (v.contentOmitted ? (v.contentOmitted !== true || v.content !== '' || !/^transient:[a-f0-9]{64}$/.test(v.actionId))
          : hash({ content: v.content, imageIds: v.images.map(p => p.id), visibility: v.visibility }) !== v.fingerprint)
        || (v.status === 'sent' && (typeof v.tid !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(v.tid) || v.tid === '0')))
        throw Error('state');
      return v;
    } catch { throw new QQError('state', '空间回执损坏或版本不兼容，已阻止重发并保留原文件。'); }
  }
  async save(ledger: Ledger, first = false) {
    await mkdir(this.root, { recursive: true });
    if ((await lstat(this.root)).isSymbolicLink()) throw new QQError('state', '空间记录目录不能是链接。');
    const target = this.path(ledger);
    // First creation is exclusive. A crash leaves either a valid pending or a damaged
    // file which read() refuses. Never replace an existing action with a new attempt.
    const path = first ? target : `${target}.${randomUUID()}.tmp`;
    const file = await open(path, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(ledger)); await file.sync(); }
    catch (error) {
      await file.close();
      if (!first) await unlink(path).catch(() => {});
      throw error;
    }
    await file.close();
    if (!first) {
      try { await rename(path, target); }
      finally { await unlink(path).catch(() => {}); }
    }
  }
}
