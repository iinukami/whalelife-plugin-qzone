/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { QQError } from './validation.ts';
import type { MediaResolver, VisualReader, MediaCollector } from './types.ts';

/** One declared optional provider, tied to both sides' lifecycle. */
export class Extension<T extends (...args: any[]) => Promise<any>> {
  private entry?: { handler: T; signal: AbortSignal; dispose: () => void; controller: AbortController };
  register(handler: T, options: { signal: AbortSignal }) {
    if (typeof handler !== 'function' || !options?.signal?.addEventListener) throw new QQError('extension', '接入需要生命周期信号。');
    options.signal.throwIfAborted();
    if (this.entry) throw new QQError('extension', '已有同类接入，请先停用原接入。');
    const entry = { handler, signal: options.signal, controller: new AbortController(), dispose: () => {
      if (this.entry === entry) this.entry = undefined;
      options.signal.removeEventListener('abort', entry.dispose); entry.controller.abort();
    } };
    this.entry = entry; options.signal.addEventListener('abort', entry.dispose, { once: true });
    return entry.dispose;
  }
  active() { return !!this.entry && !this.entry.signal.aborted; }
  dispose() { this.entry?.dispose(); }
  async use<A, R>(input: A, caller: AbortSignal): Promise<R> {
    const entry = this.entry;
    if (!entry) throw new QQError('extension', '所需接入尚未启用。');
    const signal = AbortSignal.any([caller, entry.signal, entry.controller.signal, AbortSignal.timeout(30000)]);
    signal.throwIfAborted();
    let abort = () => {};
    try {
      const cancelled = new Promise<never>((_, reject) => { abort = () => reject(Error('接入已取消或超时。')); signal.addEventListener('abort', abort, { once: true }); });
      const value = await Promise.race([entry.handler(input, { signal }), cancelled]);
      signal.throwIfAborted(); return value;
    } finally { signal.removeEventListener('abort', abort); }
  }
}
export const mediaExtension = () => new Extension<MediaResolver>();
export const visualExtension = () => new Extension<VisualReader>();
export const collectionExtension = () => new Extension<MediaCollector>();
