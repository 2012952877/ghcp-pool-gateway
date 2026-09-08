import { redactFields } from './redact.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export class Logger {
  private readonly minLevel: LogLevel;

  constructor(
    private readonly service: string,
    private readonly scope: string,
    logLevel = process.env.LOG_LEVEL,
  ) {
    this.minLevel = parseLogLevel(logLevel);
  }

  debug(event: string, message: string, fields?: Record<string, unknown>): void {
    this.write('debug', event, message, fields);
  }

  info(event: string, message: string, fields?: Record<string, unknown>): void {
    this.write('info', event, message, fields);
  }

  warn(event: string, message: string, fields?: Record<string, unknown>): void {
    this.write('warn', event, message, fields);
  }

  error(event: string, message: string, fields?: Record<string, unknown>): void {
    this.write('error', event, message, fields);
  }

  private write(level: LogLevel, event: string, message: string, fields?: Record<string, unknown>): void {
    if (LEVELS[level] < LEVELS[this.minLevel]) return;
    const suffix = fields ? ` ${JSON.stringify(redactFields(fields))}` : '';
    const line = `${new Date().toISOString()} [${this.service}:${this.scope}] ${level.toUpperCase()} ${event}: ${message}${suffix}`;
    console[level === 'debug' ? 'log' : level](line);
  }
}

export function loggerFor(service: string, scope: string, logLevel?: string): Logger {
  return new Logger(service, scope, logLevel);
}

export function errorFields(err: unknown): Record<string, unknown> {
  return {
    error: err instanceof Error ? err.message : String(err),
  };
}

function parseLogLevel(value: string | undefined): LogLevel {
  const normalized = value?.trim().toLowerCase();
  return normalized === 'debug' || normalized === 'warn' || normalized === 'error' || normalized === 'info' ? normalized : 'info';
}
