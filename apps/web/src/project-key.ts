/** Compare Windows paths consistently without merging case-sensitive POSIX paths. */
export function projectKey(value: string): string {
  const windows = /^[a-z]:[/\\]/i.test(value) || value.startsWith('\\\\');
  let normalized = value.replace(/\\/g, '/').replace(/\/+$/, '');
  if (windows) normalized = normalized.toLowerCase();
  return normalized || '/';
}
