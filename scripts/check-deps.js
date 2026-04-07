import { statSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sentinel = join(root, 'node_modules', '.package-lock.json');
const packageJson = join(root, 'package.json');
const packageLock = join(root, 'package-lock.json');

if (!existsSync(sentinel)) {
  console.error(
    '\x1b[31m✗ node_modules not found. Please run:\x1b[0m\n\n' +
    '  \x1b[36mnpm install\x1b[0m\n'
  );
  process.exit(1);
}

const sentinelTime = statSync(sentinel).mtimeMs;
const pkgTime = statSync(packageJson).mtimeMs;
const lockTime = existsSync(packageLock) ? statSync(packageLock).mtimeMs : 0;

if (pkgTime > sentinelTime || lockTime > sentinelTime) {
  console.error(
    '\x1b[33m⚠ Dependencies appear out of date (package.json or package-lock.json is newer than node_modules). Please run:\x1b[0m\n\n' +
    '  \x1b[36mnpm install\x1b[0m\n'
  );
  process.exit(1);
}
