import type { Request } from 'express';
import { config } from '../config.js';

export const CLAUDE_CODE_OPTIMIZED_HEADER = 'X-Claude-Code-Optimized';

export type ClaudeCodeModeResolution =
  | { ok: true; enabled: boolean }
  | { ok: false; message: string };

export function resolveClaudeCodeOptimized(req: Request): ClaudeCodeModeResolution {
  const rawValue = req.header(CLAUDE_CODE_OPTIMIZED_HEADER);
  if (rawValue === undefined) return { ok: true, enabled: config.claudeCodeOptimized };

  const value = rawValue.trim();
  const parsed = parseBooleanHeader(value);
  if (parsed !== undefined) return { ok: true, enabled: parsed };

  return {
    ok: false,
    message: `Invalid ${CLAUDE_CODE_OPTIMIZED_HEADER} header "${value}". Use true/false, 1/0, yes/no, or on/off.`,
  };
}

function parseBooleanHeader(value: string): boolean | undefined {
  if (/^(1|true|yes|on)$/i.test(value)) return true;
  if (/^(0|false|no|off)$/i.test(value)) return false;
  return undefined;
}
