/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { PublishPayload, TransportReceipt } from './types.ts';
import { QZONE_LIMITS } from './policy.ts';


export async function validateImages(input: PublishPayload) {
  if (!Array.isArray(input.images) || input.images.length > QZONE_LIMITS.images) throw Error('images');
  let total = 0;
  for (const p of input.images) {
    if (!p || !/^[a-f0-9]{64}$/.test(p.id) || typeof p.base64 !== 'string' || p.base64.length > Math.ceil(QZONE_LIMITS.bytes / 3) * 4
      || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(p.mime)) throw Error('image');
    const bytes = Buffer.from(p.base64, 'base64'); total += bytes.length;
    if (!bytes.length || total > QZONE_LIMITS.bytes || bytes.toString('base64') !== p.base64
      || createHash('sha256').update(bytes).digest('hex') !== p.id) throw Error('image');
    const info = await sharp(bytes, { limitInputPixels: QZONE_LIMITS.pixels }).metadata();
    if ('image/' + info.format !== p.mime || (info.width ?? 0) * (info.height ?? 0) > QZONE_LIMITS.pixels) throw Error('image');
  }
}
