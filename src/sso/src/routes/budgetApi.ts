import { Router } from 'express';
import { apiError, errorFields, loggerFor } from '@ghcp/shared';
import { readAiCreditsUsage, refreshAiCreditsUsage } from '../budget/budgetService.js';

export const budgetApiRouter = Router();
const logger = loggerFor('sso', 'ai-credits-api');

budgetApiRouter.get('/ai-credits/usage', (_req, res) => {
  const usage = readAiCreditsUsage();
  if (!usage) {
    res.status(404).json(apiError('ai_credits_usage_not_found', 'AI Credits usage cache was not found.'));
    return;
  }
  res.json(usage);
});

budgetApiRouter.post('/ai-credits/usage/refresh', async (_req, res) => {
  try {
    logger.info('refresh-ai-credits-start', 'Refreshing AI Credits usage cache');
    res.json(await refreshAiCreditsUsage());
    logger.info('refresh-ai-credits-done', 'Refreshed AI Credits usage cache');
  } catch (err) {
    logger.error('refresh-ai-credits-failed', 'AI Credits usage refresh failed', { ...errorFields(err) });
    res.status(400).json(apiError('ai_credits_refresh_failed', (err as Error).message));
  }
});
