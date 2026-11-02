/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { QQError } from './validation.ts';
/** Errors cross process boundaries as plain Error. Only our exact fixed messages
 * may cross back to a model/page; never echo HTTP responses, cookies or raw errors. */
const known = new Set([
  '空间响应格式不受支持。', '空间未返回可用动态，请检查登录、空间访问权限或平台限制。',
  '空间返回了 HTML 页面，当前登录态或访问方式可能不适用。', '空间响应没有可识别的 JSON/JSONP 外层。', '空间响应包含无法解析的数据字面量。',
  '空间动态结构发生变化，未开放互动。', 'QQ 不在线，未访问空间。', 'QQ 未提供可用的空间登录态。',
  '空间登录态与当前 QQ 账号不一致。', '空间服务请求失败或响应过大。', '空间响应超过读取上限。',
  'QQ 账号或连接已变化。', '动态引用已过期、账号已变化或不属于本会话，请重新浏览。',
  '图片来源不受支持。', '图片格式不受支持。', '图片序号无效。', '空间网络读取失败，请检查网络或代理环境。',
  '请在 QQ 设置中选择能看图的模型。', '所选识别模型用途或协议不受支持。', '看图模型未返回识别结果。',
]);
export function spaceError(error: unknown, fallback: string): string {
  return error instanceof QQError || (error instanceof Error && (known.has(error.message) || /^空间响应解析失败（行 \d+，列 \d+，字符码 \d+）。$/.test(error.message))) ? error.message : fallback;
}
