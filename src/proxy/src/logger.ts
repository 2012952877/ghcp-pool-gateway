import { Logger as SharedLogger } from '@ghcp/shared';

export class Logger extends SharedLogger {
  constructor(scope: string) {
    super('proxy', scope);
  }
}
