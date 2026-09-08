import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../config.js';
import type { SsoUserRecord } from './usersRepo.js';

export function appendUserEvent(action: string, user: Pick<SsoUserRecord, 'ssoUser' | 'email' | 'role' | 'ghLogin'>): void {
  mkdirSync(dirname(config.eventLogPath), { recursive: true });
  appendFileSync(
    config.eventLogPath,
    JSON.stringify({
      time: new Date().toISOString(),
      action,
      sso_user: user.ssoUser,
      email: user.email,
      role: user.role,
      gh_login: user.ghLogin,
    }) + '\n',
  );
}
