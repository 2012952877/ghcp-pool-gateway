export function nowIso(): string {
  return new Date().toISOString();
}

export function epochSeconds(date = new Date()): number {
  return Math.floor(date.getTime() / 1000);
}

export function isoFromEpochSeconds(value: number): string {
  return new Date(value * 1000).toISOString();
}
