/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
export class QQError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
export function safeError(error: unknown): string {
  return error instanceof QQError ? error.message : '操作未完成，请检查连接或配置；敏感错误详情未输出。';
}
export function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function id(value: unknown): string {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (typeof value === 'string' && /^-?\d{1,20}$/.test(value)) return BigInt(value).toString();
  throw new QQError('invalid_id', '消息或账号标识无效。');
}
export function account(value: unknown): string {
  const result = id(value);
  if (!/^[1-9]\d{4,19}$/.test(result)) throw new QQError('invalid_account', 'QQ 号格式无效。');
  return result;
}
