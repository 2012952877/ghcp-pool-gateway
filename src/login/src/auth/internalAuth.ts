import type { NextFunction, Request, Response } from 'express';
import { apiError, INTERNAL_AUTH_HEADER } from '@ghcp/shared';
import { config } from '../config.js';

export function requireInternalToken(req: Request, res: Response, next: NextFunction): void {
  if (!config.internalApiToken || req.header(INTERNAL_AUTH_HEADER) !== config.internalApiToken) {
    res.status(401).json(apiError('internal_auth_failed', 'Invalid internal service token.'));
    return;
  }
  next();
}
