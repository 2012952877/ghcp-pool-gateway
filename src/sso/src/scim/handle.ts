export function normalizeHandle(userName: string, shortcode: string): string {
  const local = userName.includes('@') ? userName.split('@')[0]! : userName;
  let handle = local
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  const maxLocal = Math.max(1, 39 - (shortcode.length + 1));
  if (handle.length > maxLocal) handle = handle.slice(0, maxLocal).replace(/-+$/g, '');
  return `${handle}_${shortcode}`;
}
