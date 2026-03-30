export const DEFAULT_PROJECT_SYNC_EXCLUDES = ['.git', 'node_modules', '__pycache__', '*.pyc', '.DS_Store', '.venvs'];
export const DEFAULT_PROJECT_SYNC_DOWN_EXCLUDES = [...DEFAULT_PROJECT_SYNC_EXCLUDES, '.gitignore'];
export const DEFAULT_PROJECT_SYNC_RSYNC_FLAGS = ['--update'];

export function shellEscape(value) {
  const text = String(value ?? '');
  if (text.length === 0) return "''";
  return `'${text.replace(/'/g, `'\"'\"'`)}'`;
}

function escapeForDoubleQuotes(value) {
  return String(value ?? '').replace(/["\\$`]/g, '\\$&');
}

export function shellEscapeRemotePath(value) {
  const text = String(value ?? '');

  if (text === '~') return '"$HOME"';
  if (text.startsWith('~/')) return `"$HOME/${escapeForDoubleQuotes(text.slice(2))}"`;

  return shellEscape(text);
}

export function getRemoteProjectPath(workDir = '~', projectName) {
  const remoteBase = workDir.endsWith('/') ? workDir : `${workDir}/`;
  return `${remoteBase}${projectName}/`;
}

export function normalizeSyncDownPaths(files = []) {
  const candidates = Array.isArray(files) ? files : [];

  const seen = new Set();

  return candidates
    .map(file => String(file ?? '').trim())
    .map(file => file.replace(/^(?:\.\/*)+/, '').replace(/^\/+/, ''))
    .filter(file => file && file !== '.')
    .filter((file) => {
      if (seen.has(file)) return false;
      seen.add(file);
      return true;
    });
}

export function buildRemoteSyncDownSources({ user, host, remotePath, files = [] }) {
  return buildRemoteSyncDownEntries({ user, host, remotePath, files }).map(entry => entry.source);
}

export function buildRemoteProjectSource({ user, host, remotePath }) {
  return `${user}@${host}:${remotePath}`;
}

export function buildRemoteSyncDownEntries({ user, host, remotePath, files = [] }) {
  return normalizeSyncDownPaths(files).map(relativePath => ({
    relativePath,
    remoteTargetPath: `${remotePath}${relativePath}`,
    source: `${user}@${host}:${remotePath}${relativePath}`,
  }));
}

export function partitionRemoteSyncDownEntries(entries, existingRelativePaths = []) {
  const existingSet = new Set(existingRelativePaths);

  return {
    existingEntries: entries.filter(entry => existingSet.has(entry.relativePath)),
    missingEntries: entries.filter(entry => !existingSet.has(entry.relativePath)),
  };
}

export function buildRsyncCommand({ sshCmd, sources, destination, excludePatterns = [], optionFlags = [] }) {
  const sourceList = Array.isArray(sources) ? sources : [sources];
  const args = [
    'rsync',
    '-avz',
    ...optionFlags,
    ...excludePatterns.flatMap(pattern => ['--exclude', pattern]),
    '-e',
    sshCmd,
    ...sourceList,
    destination,
  ];

  return args.map(shellEscape).join(' ');
}
