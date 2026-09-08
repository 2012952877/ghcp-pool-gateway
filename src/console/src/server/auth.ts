import type { NextFunction, Request, Response } from 'express';
import { apiError } from '@ghcp/shared';

interface ConsoleSession {
  admin?: { username: string; role: 'admin' };
}

export function session(req: Request): ConsoleSession {
  return req.session as unknown as ConsoleSession;
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!session(req).admin) {
    res.status(401).json(apiError('not_authenticated', 'Console login is required.'));
    return;
  }
  next();
}
