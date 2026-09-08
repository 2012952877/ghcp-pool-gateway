import { JsonHttpClient, type CreateLoginTaskRequest, type LoginTaskDto } from '@ghcp/shared';
import { config } from '../config.js';

const client = new JsonHttpClient({
  baseUrl: config.loginBaseUrl,
  internalToken: config.internalApiToken,
});

export async function createLoginTask(request: CreateLoginTaskRequest): Promise<LoginTaskDto> {
  return client.request<LoginTaskDto>('/api/tasks', { method: 'POST', body: request });
}
