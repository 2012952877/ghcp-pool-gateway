import 'dotenv/config';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { loggerFor } from '@ghcp/shared';

const port = Number(process.env.PORT ?? 8002);
const scimToken = process.env.SCIM_TOKEN ?? 'change-me';
const shortcode = process.env.ENTERPRISE_SHORTCODE ?? 'octo';
const app = express();
const logger = loggerFor('mock-github', 'scim');
app.use(express.json({ type: ['application/json', 'application/scim+json'] }));

interface GithubUser {
  scimId: string;
  externalId?: string;
  userName: string;
  handle: string;
  displayName?: string;
  email?: string;
  roles?: ScimRole[];
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

interface ScimRole {
  value: string;
  primary?: boolean;
  display?: string;
  type?: string;
}

interface ScimUserBody {
  userName?: string;
  externalId?: string;
  displayName?: string;
  emails?: { value: string; primary?: boolean }[];
  roles?: ScimRole[];
  active?: boolean;
}

const users = new Map<string, GithubUser>();

app.get('/healthz', (_req, res) => {
  res.json({ status: 'ok', service: 'mock-github' });
});

app.use('/scim/v2/enterprises/:enterprise', (req, res, next) => {
  const startedAt = Date.now();
  res.on('finish', () => {
    logger.info('request', 'SCIM request completed', {
      method: req.method,
      path: req.originalUrl,
      enterprise: req.params.enterprise,
      status: res.statusCode,
      durationMs: Date.now() - startedAt,
    });
  });
  if (req.headers.authorization !== `Bearer ${scimToken}`) {
    logger.warn('unauthorized', 'Rejected SCIM request with invalid authorization header', {
      method: req.method,
      path: req.originalUrl,
      enterprise: req.params.enterprise,
    });
    res.status(401).json(scimError('Unauthorized', 401));
    return;
  }
  next();
});

app.get('/scim/v2/enterprises/:enterprise/Users', (req, res) => {
  const all = [...users.values()];
  const filter = typeof req.query.filter === 'string' ? req.query.filter : '';
  const match = filter.match(/userName eq "?([^"]+)"?/i);
  const resources = match ? all.filter((user) => user.userName.toLowerCase() === match[1]!.toLowerCase()) : all;
  res.json({
    schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
    totalResults: resources.length,
    startIndex: 1,
    itemsPerPage: resources.length,
    Resources: resources.map(toScim),
  });
});

app.post('/scim/v2/enterprises/:enterprise/Users', (req, res) => {
  const body = req.body as ScimUserBody;
  if (!body.userName) {
    res.status(400).json(scimError('userName is required', 400));
    return;
  }
  if ([...users.values()].some((user) => user.userName.toLowerCase() === body.userName!.toLowerCase())) {
    res.status(409).json(scimError(`User ${body.userName} already exists`, 409));
    return;
  }
  const now = new Date().toISOString();
  const user: GithubUser = {
    scimId: randomUUID(),
    externalId: body.externalId,
    userName: body.userName,
    handle: normalizeHandle(body.userName),
    displayName: body.displayName,
    email: body.emails?.find((email) => email.primary)?.value ?? body.emails?.[0]?.value,
    roles: body.roles,
    active: body.active ?? true,
    createdAt: now,
    updatedAt: now,
  };
  users.set(user.scimId, user);
  logger.info('create-user', 'Created mock SCIM user', { userName: user.userName, scimId: user.scimId, handle: user.handle, roles: user.roles });
  res.status(201).json(toScim(user));
});

app.put('/scim/v2/enterprises/:enterprise/Users/:id', (req, res) => {
  const existing = users.get(req.params.id);
  if (!existing) {
    res.status(404).json(scimError('User not found', 404));
    return;
  }
  const body = req.body as ScimUserBody;
  const userName = body.userName ?? existing.userName;
  const updated: GithubUser = {
    ...existing,
    externalId: body.externalId ?? existing.externalId,
    userName,
    handle: normalizeHandle(userName),
    displayName: body.displayName ?? existing.displayName,
    email: body.emails?.find((email) => email.primary)?.value ?? existing.email,
    roles: body.roles ?? existing.roles,
    active: body.active ?? existing.active,
    updatedAt: new Date().toISOString(),
  };
  users.set(updated.scimId, updated);
  logger.info('update-user', 'Updated mock SCIM user', { userName: updated.userName, scimId: updated.scimId, handle: updated.handle, roles: updated.roles });
  res.json(toScim(updated));
});

app.patch('/scim/v2/enterprises/:enterprise/Users/:id', (req, res) => {
  const existing = users.get(req.params.id);
  if (!existing) {
    res.status(404).json(scimError('User not found', 404));
    return;
  }
  const ops = (req.body?.Operations ?? []) as { op?: string; path?: string; value?: unknown }[];
  let active = existing.active;
  for (const op of ops) {
    if (op.path === 'active') active = Boolean(op.value);
  }
  const updated = { ...existing, active, updatedAt: new Date().toISOString() };
  users.set(existing.scimId, updated);
  logger.info('patch-user', 'Patched mock SCIM user', { userName: updated.userName, scimId: updated.scimId, active: updated.active });
  res.json(toScim(updated));
});

app.delete('/scim/v2/enterprises/:enterprise/Users/:id', (req, res) => {
  const existing = users.get(req.params.id);
  if (!users.delete(req.params.id)) {
    res.status(404).json(scimError('User not found', 404));
    return;
  }
  logger.info('delete-user', 'Deleted mock SCIM user', { userName: existing?.userName, scimId: req.params.id });
  res.status(204).end();
});

app.listen(port, () => {
  console.log(`[mock-github] listening on http://localhost:${port}`);
});

function toScim(user: GithubUser): Record<string, unknown> {
  return {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
    id: user.scimId,
    externalId: user.externalId,
    userName: user.userName,
    displayName: user.displayName,
    emails: user.email ? [{ value: user.email, primary: true, type: 'work' }] : undefined,
    roles: user.roles,
    active: user.active,
    githubLogin: user.handle,
    meta: { resourceType: 'User', created: user.createdAt, lastModified: user.updatedAt },
  };
}

function scimError(detail: string, status: number): Record<string, unknown> {
  return { schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'], detail, status: String(status) };
}

function normalizeHandle(userName: string): string {
  const local = userName.includes('@') ? userName.split('@')[0]! : userName;
  let handle = local.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const maxLocal = Math.max(1, 39 - (shortcode.length + 1));
  if (handle.length > maxLocal) handle = handle.slice(0, maxLocal).replace(/-+$/g, '');
  return `${handle}_${shortcode}`;
}
