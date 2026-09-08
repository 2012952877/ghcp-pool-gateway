import type { NextFunction, Request, Response } from 'express';
import { apiError } from '@ghcp/shared';
import { config } from '../config.js';

export function requireIdentityHeader(req: Request, res: Response, next: NextFunction): void {
  const identity = req.header(config.identityHeader)?.trim();
  if (!identity && config.identityHeaderRequired) {
    res.status(400).json(apiError('missing_identity_header', `Missing required identity header "${config.identityHeader}".`));
    return;
  }
  req.identity = identity || 'default';
  next();
}
