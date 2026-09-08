import type {
  BatchResult,
  ClearProxyErrorDiagnosticsResponse,
  DeleteProxyAccountResult,
  ImportCopilotOauthTokenRow,
  PageResponse,
  ProxyAccountDto,
  ProxyErrorDiagnosticDetailDto,
  ProxyErrorDiagnosticsListResponse,
  ProxyRequestStatDto,
  SsoType,
} from '@ghcp/shared';
import { api, downloadApi } from './client.js';

export interface ListProxyAccountsQuery {
  q?: string;
  page?: number;
  pageSize?: number;
  sort?: string;
  dir?: 'asc' | 'desc';
}

export function listProxyAccounts(params: ListProxyAccountsQuery = {}): Promise<PageResponse<ProxyAccountDto>> {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const queryString = search.toString();
  return api<PageResponse<ProxyAccountDto> | ProxyAccountDto[]>(`/api/console/proxy/accounts${queryString ? `?${queryString}` : ''}`)
    .then((result) => {
      if (!Array.isArray(result)) return result;
      const page = Math.max(1, Math.trunc(params.page ?? 1));
      const pageSize = Math.max(1, Math.trunc(params.pageSize ?? (result.length || 25)));
      return {
        items: result,
        total: result.length,
        page,
        pageSize,
      };
    });
}

export function getProxyAccount(identity: string): Promise<ProxyAccountDto> {
  return api<ProxyAccountDto>(`/api/console/proxy/accounts/${encodeURIComponent(identity)}`);
}

export function deleteProxyAccount(identity: string): Promise<DeleteProxyAccountResult> {
  return api<DeleteProxyAccountResult>(`/api/console/proxy/accounts/${encodeURIComponent(identity)}`, { method: 'DELETE' });
}

export function listRequestStats(params: { identity?: string; limit?: number } = {}): Promise<ProxyRequestStatDto[]> {
  const search = new URLSearchParams();
  if (params.limit) search.set('limit', String(params.limit));
  if (params.identity) {
    return api<ProxyRequestStatDto[]>(`/api/console/proxy/accounts/${encodeURIComponent(params.identity)}/request-stats${query(search)}`);
  }
  return api<ProxyRequestStatDto[]>(`/api/console/proxy/request-stats${query(search)}`);
}

export function reauthorizeCopilotOauth(identity: string, body: { ssoPassword: string; ssoType: SsoType }): Promise<ProxyAccountDto | undefined> {
  return api<ProxyAccountDto | undefined>(`/api/console/proxy/accounts/${encodeURIComponent(identity)}/copilot-oauth/reauthorize`, { method: 'POST', body: JSON.stringify(body) });
}

export function importCopilotOauthTokens(csvText: string): Promise<BatchResult<ImportCopilotOauthTokenRow>> {
  return api<BatchResult<ImportCopilotOauthTokenRow>>('/api/console/proxy/accounts/copilot-oauth-token/import', {
    method: 'POST',
    body: JSON.stringify({ csvText }),
  });
}

export function listErrorDiagnostics(params: { page?: number; pageSize?: number } = {}): Promise<ProxyErrorDiagnosticsListResponse> {
  const search = new URLSearchParams();
  if (params.page) search.set('page', String(params.page));
  if (params.pageSize) search.set('pageSize', String(params.pageSize));
  return api<ProxyErrorDiagnosticsListResponse>(`/api/console/proxy/error-diagnostics${query(search)}`);
}

export function getErrorDiagnostic(id: string): Promise<ProxyErrorDiagnosticDetailDto> {
  return api<ProxyErrorDiagnosticDetailDto>(`/api/console/proxy/error-diagnostics/${encodeURIComponent(id)}`);
}

export function downloadErrorDiagnostic(id: string): Promise<{ blob: Blob; filename: string }> {
  return downloadApi(`/api/console/proxy/error-diagnostics/${encodeURIComponent(id)}/download`);
}

export function clearErrorDiagnostics(): Promise<ClearProxyErrorDiagnosticsResponse> {
  return api<ClearProxyErrorDiagnosticsResponse>('/api/console/proxy/error-diagnostics', {
    method: 'DELETE',
    body: JSON.stringify({ confirm: true }),
  });
}

function query(search: URLSearchParams): string {
  const value = search.toString();
  return value ? `?${value}` : '';
}

// ─────────────────────────── 账号池 ───────────────────────────

export type PoolStrategy = 'sticky-affinity' | 'least-loaded' | 'round-robin';
export type PoolMemberState = 'active' | 'cooling' | 'disabled';

export interface PoolMemberDto {
  poolId: string;
  identity: string;
  weight: number;
  state: PoolMemberState;
  coolingUntil?: string;
  consecutiveFailures: number;
  lastUsedAt?: string;
  available: boolean;
}

export interface PoolDto {
  poolId: string;
  strategy: PoolStrategy;
  sessionTtlSeconds: number;
  cooldownSeconds: number;
  failureThreshold: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  members: PoolMemberDto[];
  activeMembers: number;
  totalMembers: number;
}

const POOLS = '/api/console/proxy/pools';

export function listPools(): Promise<{ items: PoolDto[]; total: number }> {
  return api(POOLS);
}

export function getPool(poolId: string): Promise<PoolDto> {
  return api(`${POOLS}/${encodeURIComponent(poolId)}`);
}

export function createPool(input: {
  poolId: string;
  strategy?: PoolStrategy;
  sessionTtlSeconds?: number;
  cooldownSeconds?: number;
  failureThreshold?: number;
}): Promise<PoolDto> {
  return api(POOLS, { method: 'POST', body: JSON.stringify(input) });
}

export function updatePool(poolId: string, input: {
  strategy?: PoolStrategy;
  sessionTtlSeconds?: number;
  cooldownSeconds?: number;
  failureThreshold?: number;
  enabled?: boolean;
}): Promise<PoolDto> {
  return api(`${POOLS}/${encodeURIComponent(poolId)}`, { method: 'PATCH', body: JSON.stringify(input) });
}

export function deletePool(poolId: string): Promise<{ deleted: boolean }> {
  return api(`${POOLS}/${encodeURIComponent(poolId)}`, { method: 'DELETE' });
}

export function addPoolMember(poolId: string, identity: string, weight?: number): Promise<PoolMemberDto> {
  return api(`${POOLS}/${encodeURIComponent(poolId)}/members`, {
    method: 'POST',
    body: JSON.stringify({ identity, weight }),
  });
}

export function removePoolMember(poolId: string, identity: string): Promise<{ removed: boolean }> {
  return api(`${POOLS}/${encodeURIComponent(poolId)}/members/${encodeURIComponent(identity)}`, { method: 'DELETE' });
}

export function resumePoolMember(poolId: string, identity: string): Promise<PoolDto> {
  return api(`${POOLS}/${encodeURIComponent(poolId)}/members/${encodeURIComponent(identity)}/resume`, { method: 'POST' });
}

export function pruneSessionAffinity(): Promise<{ removed: number }> {
  return api(`${POOLS}/maintenance/prune-sessions`, { method: 'POST' });
}
