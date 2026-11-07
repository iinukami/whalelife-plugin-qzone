/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { QQError } from './validation.ts';
import type { QQSpaceTransport } from './types.ts';

/** Consumer subset of vision/CONTRACT.md, serviceVersion 1.0.0.
 * No provider implementation or private storage is imported. */
export interface VisionMediaService {
  status(): Promise<Record<string, unknown>> | Record<string, unknown>;
  offerMedia(input: { sessionId: string; mime: string; base64: string }, options: { signal: AbortSignal }): Promise<{
    mediaRef: string; expiresAt: string;
    info: { kind: string; mime: string; width: number; height: number; durationSeconds: number | null; hasAudio: boolean };
  }>;
  release(input: { sessionId: string; mediaRef: string }, options: { signal: AbortSignal }): Promise<unknown>;
}
type Binding = { service: VisionMediaService; signal: AbortSignal };
export type VideoState = { available: boolean; reason: string; message: string };
const state = (reason: string, message: string): VideoState => ({ available: reason === 'ready', reason, message });
const stopped = () => new QQError('cancelled', '空间视频读取已取消或接入已停用。');
const videoFailure = '视频准备失败，请检查视觉插件状态或重新选择视频；尚未查看画面。';
const visionErrors = new Set([
  '视觉处理繁忙，请稍后重试。', '视觉临时容量已满，请释放旧引用或等待过期。',
  '媒体超过单文件容量限制。', '媒体字节为空或超过限制。',
  '视觉处理已取消或超时。', '视觉插件已停用。',
]);

async function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort = () => {};
  try {
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(stopped());
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    });
    const value = await Promise.race([work, cancelled]);
    if (signal.aborted) throw stopped();
    return value;
  } finally { signal.removeEventListener('abort', abort); }
}

/** Optional source-to-vision adapter. Only metadata is returned to the temporary
 * tool; vision_view alone delivers native image parts to the current model. */
export class SpaceVideo {
  private binding?: Binding;
  private qq: QQSpaceTransport;
  private hostReady: boolean;
  constructor(qq: QQSpaceTransport, hostReady: boolean) { this.qq = qq; this.hostReady = hostReady; }
  bind(binding: Binding) {
    this.binding = binding;
    return () => { if (this.binding === binding) this.binding = undefined; };
  }
  async status(caller?: AbortSignal, binding = this.binding): Promise<VideoState> {
    if (this.qq.qzoneVideoApiVersion !== '1.0.0' || typeof this.qq.qzoneReadVideo !== 'function')
      return state('transport_required', '当前 QQ 插件尚未提供空间视频读取接口。');
    if (!this.hostReady) return state('multimodal_required', '空间视频需要宿主的可选服务和原生多模态工具接口。');
    if (!binding || binding.signal.aborted) return state('vision_required', '空间视频需要启用视觉插件。');
    const signal = AbortSignal.any([binding.signal, AbortSignal.timeout(5000), ...(caller ? [caller] : [])]);
    try {
      const v = await bounded(Promise.resolve(binding.service.status()), signal);
      if (binding !== this.binding) throw stopped();
      if (v?.serviceVersion !== '1.0.0' || typeof binding.service.offerMedia !== 'function' || typeof binding.service.release !== 'function')
        return state('vision_incompatible', '当前视觉服务版本不兼容空间视频接入。');
      if (v.mediaPreparation !== true) return state('vision_unavailable', '视觉插件暂时不能准备媒体，请检查视觉插件状态。');
      if (v.mainModelViewing !== true) return state('multimodal_required', '视觉插件尚未启用主模型查看工具。');
      if (v.videoDecoder !== 'bundled') return state('decoder_unavailable', '视觉插件的视频组件未就绪，请检查视觉插件状态。');
      return state('ready', '可将空间视频交给当前模型按需查看；画面为采样，不包含声音。');
    } catch { return state('vision_unavailable', '视觉服务暂不可用，请检查视觉插件状态。'); }
  }
  async open(input: { sessionId: string; ref: string; index: number }, caller: AbortSignal) {
    const binding = this.binding;
    const available = await this.status(caller, binding);
    if (caller.aborted) throw stopped();
    if (!available.available || !binding) throw new QQError(available.reason, available.message);
    const signal = AbortSignal.any([caller, binding.signal, AbortSignal.timeout(120000)]);
    if (signal.aborted) throw stopped();
    // QQ validates its own sealed reference before any download; it never accepts
    // a model-supplied URL, account or platform credential here.
    const media = await bounded(this.qq.qzoneReadVideo!(input, { signal }), signal);
    if (!media || !['video/mp4', 'video/webm'].includes(media.mime) || typeof media.base64 !== 'string'
      || !media.base64.length || media.base64.length > Math.ceil(64 * 1024 * 1024 / 3) * 4)
      throw new QQError('video', 'QQ 未返回支持的视频文件，尚未查看画面。');
    let offered: Awaited<ReturnType<VisionMediaService['offerMedia']>> | undefined;
    try {
      offered = await bounded(binding.service.offerMedia({ sessionId: input.sessionId, mime: media.mime, base64: media.base64 }, { signal }), signal);
      const info = offered?.info;
      if (!/^vis_[a-f0-9]{48}$/.test(offered?.mediaRef ?? '') || !Number.isFinite(Date.parse(offered?.expiresAt))
        || !info || info.kind !== 'video' || info.mime !== media.mime
        || !Number.isInteger(info.width) || info.width < 1 || !Number.isInteger(info.height) || info.height < 1
        || typeof info.durationSeconds !== 'number' || !Number.isFinite(info.durationSeconds) || info.durationSeconds <= 0
        || typeof info.hasAudio !== 'boolean') throw new QQError('video', videoFailure);
      return { status: 'prepared', temporary: true, mediaRef: offered.mediaRef, expiresAt: new Date(offered.expiresAt).toISOString(),
        media: { kind: 'video', mime: media.mime, width: info.width, height: info.height, durationSeconds: info.durationSeconds, hasAudio: info.hasAudio },
        view: { tool: 'vision_view', mediaRef: offered.mediaRef },
        notice: '视频已准备，尚未查看画面。请调用 vision_view，传 mediaRef；默认查看前30秒，可指定时间段或时刻补看。只供当前会话本轮理解，不保存引用、画面描述或第三方内容；采样不等于逐帧完整观看，当前不含音频。' };
    } catch (error) {
      if (offered && /^vis_[a-f0-9]{48}$/.test(offered.mediaRef) && !binding.signal.aborted) {
        const cleanup = AbortSignal.any([binding.signal, AbortSignal.timeout(2000)]);
        try { await bounded(binding.service.release({ sessionId: input.sessionId, mediaRef: offered.mediaRef }, { signal: cleanup }), cleanup); } catch { /* Vision TTL remains the fallback. */ }
      }
      throw new QQError('video', signal.aborted ? stopped().message : error instanceof Error && visionErrors.has(error.message) ? error.message : videoFailure);
    }
  }
}
