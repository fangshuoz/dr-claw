import { describe, expect, it } from 'vitest';

import {
  buildRemoteProjectSource,
  buildRemoteSyncDownEntries,
  buildRemoteSyncDownSources,
  buildRsyncCommand,
  DEFAULT_PROJECT_SYNC_EXCLUDES,
  DEFAULT_PROJECT_SYNC_DOWN_EXCLUDES,
  DEFAULT_PROJECT_SYNC_RSYNC_FLAGS,
  getRemoteProjectPath,
  normalizeSyncDownPaths,
  partitionRemoteSyncDownEntries,
  shellEscapeRemotePath,
} from '../utils/computeSync.js';

describe('compute sync helpers', () => {
  it('preserves a single trailing slash in remote project paths', () => {
    expect(getRemoteProjectPath('~/workspace', 'demo')).toBe('~/workspace/demo/');
    expect(getRemoteProjectPath('~/workspace/', 'demo')).toBe('~/workspace/demo/');
  });

  it('uses the shared project excludes for full sync in both directions', () => {
    expect(DEFAULT_PROJECT_SYNC_EXCLUDES).toEqual(['.git', 'node_modules', '__pycache__', '*.pyc', '.DS_Store', '.venvs']);
  });

  it('adds extra excludes for sync down', () => {
    expect(DEFAULT_PROJECT_SYNC_DOWN_EXCLUDES).toEqual([
      '.git',
      'node_modules',
      '__pycache__',
      '*.pyc',
      '.DS_Store',
      '.venvs',
      '.gitignore',
    ]);
  });

  it('protects newer destination files with shared rsync update flags', () => {
    expect(DEFAULT_PROJECT_SYNC_RSYNC_FLAGS).toEqual(['--update']);
  });

  it('trims and deduplicates custom sync-down entries', () => {
    expect(
      normalizeSyncDownPaths([' ./logs ', '/checkpoints', './logs', '  ', '.', 'results/model.pt'])
    ).toEqual(['logs', 'checkpoints', 'results/model.pt']);
  });

  it('returns an empty list when no specific sync-down paths are requested', () => {
    expect(normalizeSyncDownPaths([])).toEqual([]);
  });

  it('builds a full-project remote rsync source', () => {
    expect(
      buildRemoteProjectSource({
        user: 'alice',
        host: 'gpu.example.com',
        remotePath: '~/runs/demo/',
      })
    ).toBe('alice@gpu.example.com:~/runs/demo/');
  });

  it('prefixes each sync-down source with the remote host', () => {
    expect(
      buildRemoteSyncDownSources({
        user: 'alice',
        host: 'gpu.example.com',
        remotePath: '~/runs/demo/',
        files: ['logs/', 'checkpoints/', 'results/'],
      })
    ).toEqual([
      'alice@gpu.example.com:~/runs/demo/logs/',
      'alice@gpu.example.com:~/runs/demo/checkpoints/',
      'alice@gpu.example.com:~/runs/demo/results/',
    ]);
  });

  it('builds sync-down entries with remote probe paths and rsync sources', () => {
    expect(
      buildRemoteSyncDownEntries({
        user: 'alice',
        host: 'gpu.example.com',
        remotePath: '~/runs/demo/',
        files: ['logs/', 'results/model.pt'],
      })
    ).toEqual([
      {
        relativePath: 'logs/',
        remoteTargetPath: '~/runs/demo/logs/',
        source: 'alice@gpu.example.com:~/runs/demo/logs/',
      },
      {
        relativePath: 'results/model.pt',
        remoteTargetPath: '~/runs/demo/results/model.pt',
        source: 'alice@gpu.example.com:~/runs/demo/results/model.pt',
      },
    ]);
  });

  it('partitions existing and missing sync-down entries', () => {
    const entries = buildRemoteSyncDownEntries({
      user: 'alice',
      host: 'gpu.example.com',
      remotePath: '~/runs/demo/',
      files: ['logs/', 'checkpoints/', 'results/'],
    });

    expect(
      partitionRemoteSyncDownEntries(entries, ['checkpoints/'])
    ).toEqual({
      existingEntries: [entries[1]],
      missingEntries: [entries[0], entries[2]],
    });
  });

  it('keeps ~ expansion available for remote shell paths', () => {
    expect(shellEscapeRemotePath('~/runs/demo')).toBe('"$HOME/runs/demo"');
    expect(shellEscapeRemotePath('/tmp/local project')).toBe("'/tmp/local project'");
  });

  it('keeps each remote source as its own shell-escaped rsync argument', () => {
    const command = buildRsyncCommand({
      sshCmd: 'ssh -o StrictHostKeyChecking=no -p 22',
      sources: [
        'alice@gpu.example.com:~/runs/demo/logs/',
        'alice@gpu.example.com:~/runs/demo/checkpoints/',
      ],
      destination: '/tmp/local project/',
      excludePatterns: ['.git', 'node_modules'],
      optionFlags: DEFAULT_PROJECT_SYNC_RSYNC_FLAGS,
    });

    expect(command).toMatch(/'--update'/);
    expect(command).toMatch(/'alice@gpu\.example\.com:~\/runs\/demo\/logs\/'/);
    expect(command).toMatch(/'alice@gpu\.example\.com:~\/runs\/demo\/checkpoints\/'/);
    expect(command).toMatch(/'\/tmp\/local project\/'/);
    expect(command).not.toMatch(/\{logs\/ checkpoints\/ results\/\}/);
  });
});
