/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import type { ToolSession } from 'whalelife';
/** QZone service v1. No cookies, arbitrary actions, file paths or model-supplied identity. */
export interface ImageSnapshot { id: string; mime: string; base64: string; description?: string }
export interface PublishPayload { accountId: string; content: string; images: ImageSnapshot[]; visibility: 'public' }
export interface TransportReceipt { status: 'sent' | 'not_submitted' | 'uncertain'; tid?: string; error?: string }
export interface QQSpaceTransport {
  qzoneApiVersion: string;
  qzoneStatus(): Promise<{ accountId: string | null; online: boolean }>;
  qzonePublish(input: PublishPayload, options: { signal: AbortSignal }): Promise<TransportReceipt>;
  qzoneSocialApiVersion?: string;
  qzoneReferenceApiVersion?: string;
  qzoneReferenceStatus?(input: ReferenceInput, options: { signal: AbortSignal }): Promise<ReferenceStatus>;
  qzoneBrowse?(input: BrowseInput, options: { signal: AbortSignal }): Promise<BrowseResult>;
  qzoneResolve?(input: { sessionId: string; ref: string }, options: { signal: AbortSignal }): Promise<PostTarget>;
  qzoneInteract?(input: { sessionId: string; ref: string; action: Interaction }, options: { signal: AbortSignal }): Promise<SocialTransportReceipt>;
  qzoneReadImage?(input: { sessionId: string; ref: string; index: number }, options: { signal: AbortSignal }): Promise<{ mime: string; base64: string }>;
  qzoneDescribeImage?(input: { sessionId: string; ref: string; index: number }, options: { signal: AbortSignal }): Promise<string>;
}
export interface ActionKey { sessionId: string; actionId: string; accountId: string }
export interface PublishInput { actionId: string; content: string; imageIds?: string[] }
export interface QzoneConfig { version: 1; enabled: boolean; visibility: 'public'; interactionWhitelist: string[]; galleryEnabled?: boolean }
export interface MediaResolver {
  (ids: string[], options: { signal: AbortSignal }): Promise<ImageSnapshot[]>;
}
export interface CollectionResult { status: 'saved' | 'uncertain'; assetId?: string; jobId?: string; archived?: boolean }
export interface MediaCollector {
  (input: { session: ToolSession; mime: string; base64: string; purposes: ('image' | 'meme')[] }, options: { signal: AbortSignal }): Promise<CollectionResult>;
}
export interface SpacePost {
  accountId: string; authorId: string; tid: string; kind: 'original' | 'repost' | 'unknown';
  text: string; images: string[]; hasVideo: boolean;
  comments: { id: string; authorId: string; text: string }[];
}
export interface Interaction {
  kind: 'like' | 'comment' | 'repost'; text?: string;
  reply?: { commentId: string; authorId: string }; mentions?: string[];
}
/** Future visual plugins register only through a declared dependency on qq/qzone.
 * Results are ephemeral, must never be returned by a persistent model tool.
 */
export interface VisualRequest { kind: 'image' | 'video'; mime: string; base64: string }
export type VisualReader = (input: VisualRequest, options: { signal: AbortSignal }) => Promise<string>;

export interface BrowseInput { sessionId: string; authorId?: string; cursor?: string; count?: number }
export interface ReferenceInput { sessionId: string; ref: string; expectedKind?: 'post' | 'cursor' }
export type ReferenceFailure = 'invalid_reference' | 'unreadable_reference' | 'offline' | 'account_changed' | 'session_mismatch' | 'expired' | 'wrong_kind';
export type ReferenceStatus = { valid: true; kind: 'post' | 'cursor'; expiresAt: number }
  | { valid: false; reason: ReferenceFailure; message: string };
export interface PostTarget {
  accountId: string; authorId: string; tid: string; kind: SpacePost['kind'];
  typeId: string; timestamp: string; interactive: boolean;
  comments: { id: string; authorId: string; replyable: boolean }[];
}
export interface BrowsePost extends Omit<SpacePost, 'images'> {
  ref: string; imageCount: number; interactive: boolean;
  comments: (SpacePost['comments'][number] & { replyable: boolean })[];
}
export interface BrowseResult { accountId: string; posts: BrowsePost[]; cursor?: string; source?: 'feed' | 'profile'; hasMore: boolean; skipped: number; diagnostics?: Record<string, number> }
export interface SocialTransportReceipt {
  status: 'sent' | 'not_submitted' | 'uncertain'; platformId?: string; platformCode?: number;
  reason?: 'platform_rejected' | 'missing_receipt' | 'response_format' | 'transport_failed' | 'preflight_rejected';
}
