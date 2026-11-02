/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import type { Context } from 'whalelife';
import type { MediaResolver, MediaCollector } from './types.ts';
import { QZONE_LIMITS } from './policy.ts';

export interface GalleryService {
    describe(id: string): Promise<{ archived: boolean; description?: string }>;
    readMedia(id: string, options: { signal: AbortSignal }): Promise<{ id: string; mime: string; base64: string }>;
    offerMedia?(input: { sessionId: string; base64: string; source: string }, options: { signal: AbortSignal }): Promise<{ mediaRef: string }>;
}

/** Shared business logic; the caller owns the optional binding or legacy child lifetime. */
export function galleryHandlers(ctx: Context, gallery: GalleryService, lifetime: AbortSignal): { resolve: MediaResolver; collect?: MediaCollector } {
  if (typeof gallery.describe !== 'function' || typeof gallery.readMedia !== 'function') throw Error('图库服务不兼容。');
  const resolve: MediaResolver = async (ids, { signal }) => {
    const combined = AbortSignal.any([lifetime, signal]);
    if (!Array.isArray(ids) || ids.length > QZONE_LIMITS.images || ids.some(id => !/^[a-f0-9]{64}$/.test(id))) throw Error('图库参数无效。');
    let size = 0;
    const snapshots = [];
    for (const id of ids) {
      combined.throwIfAborted();
      const info = await gallery.describe(id);
      if (info.archived) throw Error('图片已归档。');
      const media = await gallery.readMedia(id, { signal: combined });
      size += media.base64.length;
      if (size > Math.ceil(QZONE_LIMITS.bytes / 3) * 4) throw Error('图库图片总量超过限制。');
      snapshots.push({ ...media, description: info.description ?? '' });
    }
    combined.throwIfAborted(); return snapshots;
  };
  const collect: MediaCollector | undefined = typeof gallery.offerMedia === 'function' ? async (input, { signal }) => {
      const combined = AbortSignal.any([lifetime, signal]); combined.throwIfAborted();
      if (input.session.permission !== 'full' || !input.session.id) throw Error('收藏权限或会话无效。');
      // offerMedia writes a temporary image. It is reached only after the explicit
      // collection tool, never from browse/readImage. No platform URL or text is sent.
      const offer = await gallery.offerMedia!({ sessionId: input.session.id, base64: input.base64, source: 'qq/qzone' }, { signal: combined });
      combined.throwIfAborted();
      const called = await ctx.tools.call('gallery_collect', { mediaRef: offer.mediaRef, purposes: input.purposes },
        { ...input.session, transientContext: true, signal: combined });
      if (!called.ok) return { status: 'uncertain' };
      const result = called.result as { ok?: boolean; state?: string; asset?: { id?: string }; job?: { id?: string }; archived?: boolean };
      if (result?.ok !== true || result.state !== 'saved' || !/^[a-f0-9]{64}$/.test(result.asset?.id ?? '')) return { status: 'uncertain' };
      return { status: 'saved', assetId: result.asset!.id, archived: result.archived === true,
        ...(typeof result.job?.id === 'string' && /^[\w-]{1,128}$/.test(result.job.id) ? { jobId: result.job.id } : {}) };
    } : undefined;
  return { resolve, collect };
}

/** Kept only for old hosts. Current hosts use these handlers inside QZone. */
export async function apply(ctx: Context) {
  if (typeof ctx.optional === 'function') return;
  const space = ctx.get<{ apiVersion: string; registerMediaResolver(fn: MediaResolver, options: { signal: AbortSignal }): Promise<() => void>;
    registerMediaCollector?(fn: MediaCollector, options: { signal: AbortSignal }): Promise<() => void> }>('qq/qzone');
  const gallery = ctx.get<GalleryService>('gallery');
  if (space.apiVersion !== '1.0.0') throw Error('QQ 空间服务版本不兼容。');
  const handlers = galleryHandlers(ctx, gallery, ctx.signal);
  let dispose: (() => void) | undefined, disposeCollection: (() => void) | undefined;
  ctx.effect(() => async () => { await disposeCollection?.(); await dispose?.(); });
  dispose = await space.registerMediaResolver(handlers.resolve, { signal: ctx.signal });
  if (handlers.collect && typeof space.registerMediaCollector === 'function')
    disposeCollection = await space.registerMediaCollector(handlers.collect, { signal: ctx.signal });
}
