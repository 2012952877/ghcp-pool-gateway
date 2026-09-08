import { randomUUID } from 'node:crypto';

export function newRequestId(): string {
  return randomUUID();
}

export function newTaskId(): string {
  return randomUUID();
}

export function newBatchId(): string {
  return randomUUID();
}
