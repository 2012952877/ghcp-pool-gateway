import { createHash } from 'node:crypto';
import type { Request } from 'express';

/**
 * 推导「会话 key」—— 决定同一段对话落到池里的哪个账号。
 *
 * 为什么重要：会话键决定 sticky-affinity 策略下同一会话落在哪个成员。
 * 只要同一段上下文每次都落到同一账号，cache_read（50 AIU/1M）就能命中；
 * 一旦换账号，就要按 cache_write（625 AIU/1M）重写一遍。
 *
 * 优先级（从强到弱）：
 *   1. 显式头 X-Session-Id            —— 客户端主动控制
 *   2. body.metadata.user_id          —— Claude Code 会传
 *   3. system + 首条 user message 哈希 —— 兜底，**无需任何客户端配合**
 *
 * 第 3 条是关键：它让「相同的系统提示词/代码上下文」天然落到同一账号，
 * 即使跨会话也能复用缓存。
 */

const SESSION_HEADER = 'x-session-id';
/** 参与哈希的前缀字节数。取太长会让无关的尾部变化打散缓存，取太短会误合并 */
const PREFIX_BYTES = 4096;

export interface SessionKeySource {
  key: string;
  /** 来源，用于可观测性与排障 */
  origin: 'header' | 'metadata' | 'prompt-prefix' | 'fallback';
}

export function deriveSessionKey(req: Request, body: Record<string, unknown> | undefined): SessionKeySource {
  const headerValue = firstHeaderValue(req.headers[SESSION_HEADER]);
  if (headerValue) return { key: sha256(`hdr:${headerValue}`), origin: 'header' };

  const metadataUserId = readMetadataUserId(body);
  if (metadataUserId) return { key: sha256(`meta:${metadataUserId}`), origin: 'metadata' };

  const prefix = readPromptPrefix(body);
  if (prefix) return { key: sha256(`pfx:${prefix}`), origin: 'prompt-prefix' };

  // 连 prompt 都取不到（例如 /v1/models 这类无 body 的请求）：
  // 用固定 key，让这类请求稳定落到同一账号，避免无谓地打散。
  return { key: sha256('fallback:no-prompt'), origin: 'fallback' };
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value.find((v) => typeof v === 'string' && v.trim())?.trim();
  if (typeof value === 'string' && value.trim()) return value.trim();
  return undefined;
}

/** Anthropic Messages API 的 metadata.user_id；Claude Code 会填 */
function readMetadataUserId(body: Record<string, unknown> | undefined): string | undefined {
  if (!body) return undefined;
  const metadata = body.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined;
  const userId = (metadata as Record<string, unknown>).user_id;
  return typeof userId === 'string' && userId.trim() ? userId.trim() : undefined;
}

/**
 * 取 system + 首条 user message 的前若干字节。
 *
 * 只取**前缀**而不是全文，是因为缓存本身就是前缀匹配的：
 * 对话越往后内容差异越大，但前缀（系统提示词 + 代码上下文）是稳定的。
 */
function readPromptPrefix(body: Record<string, unknown> | undefined): string | undefined {
  if (!body) return undefined;
  const parts: string[] = [];

  // Anthropic 形状：顶层 system
  collectText(body.system, parts);

  // messages[] —— 取到第一条 user 为止
  const messages = body.messages;
  if (Array.isArray(messages)) {
    for (const message of messages) {
      if (!message || typeof message !== 'object') continue;
      const role = (message as Record<string, unknown>).role;
      collectText((message as Record<string, unknown>).content, parts);
      if (role === 'user') break;
      if (joinedLength(parts) >= PREFIX_BYTES) break;
    }
  }

  // OpenAI Responses 形状：顶层 input / instructions
  collectText(body.instructions, parts);
  collectText(body.input, parts);

  const joined = parts.join('\n');
  return joined.trim() ? joined.slice(0, PREFIX_BYTES) : undefined;
}

/** 递归提取文本：兼容 string / {text} / 数组等多种 content 形状 */
function collectText(value: unknown, out: string[]): void {
  if (joinedLength(out) >= PREFIX_BYTES) return;
  if (typeof value === 'string') {
    if (value) out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectText(item, out);
      if (joinedLength(out) >= PREFIX_BYTES) return;
    }
    return;
  }
  if (value && typeof value === 'object') {
    const text = (value as Record<string, unknown>).text;
    if (typeof text === 'string' && text) out.push(text);
    const content = (value as Record<string, unknown>).content;
    if (content !== undefined) collectText(content, out);
  }
}

function joinedLength(parts: string[]): number {
  let total = 0;
  for (const part of parts) total += part.length + 1;
  return total;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
