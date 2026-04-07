const WINDOWS_ABS_PATTERN = /^[a-z]:\//i;

export function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+/g, '/');
}

export function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || WINDOWS_ABS_PATTERN.test(value);
}

export function toRelativePath(filePath: string, projectRoot: string): string | null {
  const normalizedPath = normalizePath(String(filePath || '').trim());
  if (!normalizedPath) return null;

  const normalizedRoot = normalizePath(String(projectRoot || '').trim()).replace(/\/$/, '');
  if (normalizedRoot && normalizedPath.startsWith(`${normalizedRoot}/`)) {
    return normalizedPath.slice(normalizedRoot.length + 1);
  }

  return normalizedPath.replace(/^\.\//, '');
}

export function isSafePath(relativePath: string): boolean {
  return (
    !relativePath.startsWith('/') &&
    !relativePath.startsWith('..') &&
    !relativePath.includes('/../') &&
    !WINDOWS_ABS_PATTERN.test(relativePath)
  );
}

export function fileNameFromPath(normalizedPath: string): string {
  return normalizedPath.split('/').pop() || normalizedPath;
}
