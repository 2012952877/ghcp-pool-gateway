import { JsonHttpClient } from '@ghcp/shared';
import { config } from '../config.js';

export interface DeleteProxyAccountsBySsoUserResult {
  ssoUser: string;
  matchedAccounts: number;
  deletedAccounts: number;
  deletedRequestStats: number;
}

const client = new JsonHttpClient({
  baseUrl: config.proxyBaseUrl,
  internalToken: config.internalApiToken,
});

export async function deleteProxyAccountsBySsoUser(ssoUser: string): Promise<DeleteProxyAccountsBySsoUserResult> {
  return client.request<DeleteProxyAccountsBySsoUserResult>(`/internal/accounts/by-sso-user/${encodeURIComponent(ssoUser)}`, {
    method: 'DELETE',
  });
}
