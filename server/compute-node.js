import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import os from 'os';
import pty from 'node-pty';
import crypto from 'crypto';
import {
  buildRemoteProjectSource,
  buildRemoteSyncDownEntries,
  buildRsyncCommand,
  DEFAULT_PROJECT_SYNC_EXCLUDES,
  DEFAULT_PROJECT_SYNC_DOWN_EXCLUDES,
  DEFAULT_PROJECT_SYNC_RSYNC_FLAGS,
  getRemoteProjectPath,
  partitionRemoteSyncDownEntries,
  shellEscape,
  shellEscapeRemotePath,
} from './utils/computeSync.js';

const CONFIG_DIR = path.join(os.homedir(), '.openclaw');
const CONFIG_FILE = path.join(CONFIG_DIR, 'compute-node.json');
const ANSI_ESCAPE_REGEX = /\x1B\[[0-?]*[ -/]*[@-~]/g;
const SYNC_TASK_RETENTION_MS = 6 * 60 * 60 * 1000;
const SYNC_TASK_LOG_LIMIT = 500;
const SYNC_TASK_LIMIT_PER_NODE = 20;
const syncTasks = new Map();

// ─── ID generation ───

function generateId(hint) {
  const base = hint.replace(/[^a-zA-Z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').toLowerCase();
  const short = base.slice(0, 20) || 'node';
  return `${short}-${crypto.randomBytes(3).toString('hex')}`;
}

// ─── Config storage (multi-node) ───

async function loadRawConfig() {
  try {
    const data = await fs.readFile(CONFIG_FILE, 'utf8');
    return JSON.parse(data);
  } catch (e) {
    return { nodes: [], activeNodeId: null };
  }
}

async function migrateIfNeeded(data) {
  if (data.host && !data.nodes) {
    // Old single-node format → migrate
    const id = generateId(data.host);
    const node = {
      id,
      name: data.host,
      host: data.host,
      user: data.user,
      workDir: data.workDir || '~',
      type: 'direct',
    };
    if (data.keyPath) node.keyPath = data.keyPath;
    if (data.password) node.password = data.password;
    const migrated = { nodes: [node], activeNodeId: id };
    await saveRawConfig(migrated);
    return migrated;
  }
  return data;
}

async function saveRawConfig(config) {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}

// ─── Public config API ───

export async function loadAllNodes() {
  const raw = await loadRawConfig();
  const config = await migrateIfNeeded(raw);
  return config;
}

export async function loadNodeConfig(nodeId) {
  const config = await loadAllNodes();
  const node = config.nodes.find(n => n.id === nodeId);
  if (!node) throw new Error(`Node "${nodeId}" not found`);
  return node;
}

export async function getActiveNode() {
  const config = await loadAllNodes();
  if (!config.activeNodeId || config.nodes.length === 0) return null;
  return config.nodes.find(n => n.id === config.activeNodeId) || config.nodes[0] || null;
}

export async function saveNode(nodeConfig) {
  const config = await loadAllNodes();
  const idx = config.nodes.findIndex(n => n.id === nodeConfig.id);
  if (idx >= 0) {
    config.nodes[idx] = nodeConfig;
  } else {
    config.nodes.push(nodeConfig);
  }
  if (!config.activeNodeId || config.nodes.length === 1) {
    config.activeNodeId = nodeConfig.id;
  }
  await saveRawConfig(config);
  return nodeConfig;
}

export async function deleteNode(nodeId) {
  const config = await loadAllNodes();
  config.nodes = config.nodes.filter(n => n.id !== nodeId);
  if (config.activeNodeId === nodeId) {
    config.activeNodeId = config.nodes.length > 0 ? config.nodes[0].id : null;
  }
  await saveRawConfig(config);
}

export async function setActiveNode(nodeId) {
  const config = await loadAllNodes();
  const node = config.nodes.find(n => n.id === nodeId);
  if (!node) throw new Error(`Node "${nodeId}" not found`);
  config.activeNodeId = nodeId;
  await saveRawConfig(config);
  return node;
}

// Backward-compatible: returns active node config (flat object)
export async function loadConfig() {
  return await getActiveNode() || {};
}

export async function isComputeConfigured() {
  try {
    const node = await getActiveNode();
    return !!(node && node.host && node.user && (node.keyPath || node.password));
  } catch {
    return false;
  }
}

// ─── Shell execution helpers ───

function execLocal(command, args, options = {}) {
  if (!Array.isArray(args)) {
    options = args || {};
    args = [];
  }

  const {
    onStdout,
    onStderr,
    ...spawnOptions
  } = options;

  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { ...spawnOptions, shell: true });
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      const text = data.toString();
      stdout += text;
      onStdout?.(text);
    });
    proc.stderr.on('data', (data) => {
      const text = data.toString();
      stderr += text;
      onStderr?.(text);
    });

    proc.on('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`Command failed (code ${code}): ${stderr || stdout}`));
    });
  });
}

function execWithPassword(command, password, timeoutMs = null, onData) {
  return new Promise((resolve, reject) => {
    let output = '';
    let passwordSent = false;
    let finished = false;

    const proc = pty.spawn('bash', ['-c', command], {
      name: 'xterm',
      cols: 200,
      rows: 50,
      cwd: os.homedir(),
      env: { ...process.env, TERM: 'xterm' }
    });

    const shouldUseTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0;
    const timer = shouldUseTimeout ? setTimeout(() => {
      if (!finished) {
        finished = true;
        proc.kill();
        reject(new Error('Command timed out'));
      }
    }, timeoutMs) : null;

    proc.onData((data) => {
      const text = data.toString();
      output += text;

      if (passwordSent) {
        onData?.(text);
      }

      if (!passwordSent && /[Pp]assword[:\s]*$/.test(output.replace(ANSI_ESCAPE_REGEX, ''))) {
        passwordSent = true;
        proc.write(password + '\n');
      }
    });

    proc.onExit(({ exitCode }) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);

      let cleanOutput = output
        .replace(ANSI_ESCAPE_REGEX, '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n');

      const lines = cleanOutput.split('\n');
      const filtered = lines.filter(line => {
        const trimmed = line.trim();
        return trimmed &&
          !/^[Pp]assword[:\s]*$/.test(trimmed) &&
          trimmed !== password;
      });

      const resultLines = filtered.slice(1);
      const result = resultLines.join('\n').trim();

      if (exitCode === 0) {
        resolve(result);
      } else {
        reject(new Error(`Command failed (code ${exitCode}): ${result}`));
      }
    });
  });
}

// Execute SSH command on a specific node
async function execSsh(nodeConfig, remoteCmd, options = {}) {
  const port = nodeConfig.port || 22;
  const sshBase = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=15 -p ${port}`;
  const { onData, timeoutMs } = options;

  if (nodeConfig.keyPath) {
    const cmd = `${sshBase} -i ${nodeConfig.keyPath} ${nodeConfig.user}@${nodeConfig.host} ${JSON.stringify(remoteCmd)}`;
    return await execLocal(cmd, {
      onStdout: onData,
      onStderr: onData,
    });
  } else if (nodeConfig.password) {
    const cmd = `${sshBase} ${nodeConfig.user}@${nodeConfig.host} ${JSON.stringify(remoteCmd)}`;
    return await execWithPassword(cmd, nodeConfig.password, timeoutMs, onData);
  } else {
    throw new Error('No authentication method configured (need SSH key or password)');
  }
}

// Execute rsync on a specific node
async function execRsync(nodeConfig, src, dst, excludes = '', optionFlags = [], options = {}) {
  const port = nodeConfig.port || 22;
  const sshCmd = nodeConfig.keyPath
    ? `ssh -o StrictHostKeyChecking=no -p ${port} -i ${nodeConfig.keyPath}`
    : `ssh -o StrictHostKeyChecking=no -p ${port}`;
  const { onData } = options;
  const excludePatterns = Array.isArray(excludes)
    ? excludes
    : String(excludes || '')
        .split(/\s+--exclude\s+/)
        .map(pattern => pattern.trim())
        .filter(Boolean)
        .map(pattern => pattern.replace(/^--exclude\s+/, '').replace(/^['"]|['"]$/g, ''));
  const cmd = buildRsyncCommand({
    sshCmd,
    sources: src,
    destination: dst,
    excludePatterns,
    optionFlags,
  });

  if (nodeConfig.keyPath) {
    return await execLocal(cmd, {
      onStdout: onData,
      onStderr: onData,
    });
  } else if (nodeConfig.password) {
    return await execWithPassword(cmd, nodeConfig.password, null, onData);
  } else {
    throw new Error('No authentication method configured');
  }
}

function getProjectName(cwd) {
  return path.basename(cwd);
}

async function resolveExistingRemoteSyncDownEntries(nodeConfig, { user, host, remotePath, files = [] }) {
  const entries = buildRemoteSyncDownEntries({ user, host, remotePath, files });
  if (entries.length === 0) {
    return { existingEntries: [], missingEntries: [] };
  }

  const probeCmd = entries.map(({ relativePath, remoteTargetPath }) => (
    `if [ -e ${shellEscapeRemotePath(remoteTargetPath)} ]; then ` +
    `printf 'FOUND\\t%s\\n' ${shellEscape(relativePath)}; ` +
    `else printf 'MISSING\\t%s\\n' ${shellEscape(relativePath)}; fi`
  )).join('; ');

  const output = await execSsh(nodeConfig, probeCmd);
  const existingRelativePaths = output
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => line.split('\t'))
    .filter(([status, relativePath]) => status === 'FOUND' && relativePath)
    .map(([, relativePath]) => relativePath);

  return partitionRemoteSyncDownEntries(entries, existingRelativePaths);
}

async function remotePathExists(nodeConfig, remotePath) {
  const output = await execSsh(
    nodeConfig,
    `if [ -e ${shellEscapeRemotePath(remotePath)} ]; then printf 'FOUND'; else printf 'MISSING'; fi`
  );
  return output.trim() === 'FOUND';
}

// ─── Helper: resolve node config from optional nodeId ───

async function resolveNode(nodeId) {
  if (nodeId) {
    return await loadNodeConfig(nodeId);
  }
  const active = await getActiveNode();
  if (!active) throw new Error('No compute node configured. Please add a node first.');
  return active;
}

function trimTaskLogs(task) {
  if (task.logs.length > SYNC_TASK_LOG_LIMIT) {
    task.logs.splice(0, task.logs.length - SYNC_TASK_LOG_LIMIT);
  }
}

function appendSyncTaskLog(task, chunk) {
  const normalized = String(chunk ?? '')
    .replace(ANSI_ESCAPE_REGEX, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');

  if (!normalized) {
    return;
  }

  task.logBuffer = `${task.logBuffer || ''}${normalized}`;
  const parts = task.logBuffer.split('\n');
  task.logBuffer = parts.pop() || '';

  for (const line of parts) {
    const cleaned = line.trimEnd();
    if (!cleaned || /^[Pp]assword:\s*$/.test(cleaned)) {
      continue;
    }
    task.logs.push(cleaned);
  }

  trimTaskLogs(task);
}

function flushSyncTaskLogs(task) {
  const pending = String(task.logBuffer || '').trim();
  if (pending && !/^[Pp]assword:\s*$/.test(pending)) {
    task.logs.push(pending);
    trimTaskLogs(task);
  }
  task.logBuffer = '';
}

function cleanupSyncTasks() {
  const now = Date.now();
  const grouped = new Map();

  for (const task of syncTasks.values()) {
    const createdAt = Date.parse(task.createdAt || '') || now;
    if ((task.status === 'succeeded' || task.status === 'failed') && now - createdAt > SYNC_TASK_RETENTION_MS) {
      syncTasks.delete(task.id);
      continue;
    }

    const bucket = grouped.get(task.nodeId) || [];
    bucket.push(task);
    grouped.set(task.nodeId, bucket);
  }

  for (const tasks of grouped.values()) {
    tasks.sort((a, b) => (Date.parse(b.createdAt || '') || 0) - (Date.parse(a.createdAt || '') || 0));
    tasks.slice(SYNC_TASK_LIMIT_PER_NODE).forEach(task => syncTasks.delete(task.id));
  }
}

function serializeSyncTask(task, { includeLogs = false } = {}) {
  if (!task) return null;

  return {
    id: task.id,
    nodeId: task.nodeId,
    direction: task.direction,
    cwd: task.cwd,
    projectName: task.projectName,
    files: Array.isArray(task.files) ? [...task.files] : [],
    status: task.status,
    result: task.result,
    error: task.error,
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    logCount: task.logs.length + (task.logBuffer ? 1 : 0),
    logs: includeLogs
      ? [
          ...task.logs,
          ...(task.logBuffer ? [task.logBuffer] : []),
        ]
      : undefined,
  };
}

function getRunningSyncTaskForNode(nodeId) {
  for (const task of syncTasks.values()) {
    if (task.nodeId === nodeId && (task.status === 'queued' || task.status === 'running')) {
      return task;
    }
  }
  return null;
}

async function performSync(nodeConfig, { direction = 'up', files = [], cwd, onLog }) {
  const projectName = getProjectName(cwd);
  const remotePath = getRemoteProjectPath(nodeConfig.workDir || '~', projectName);
  const log = (line) => {
    if (line) {
      onLog?.(line);
    }
  };

  if (direction === 'up') {
    log(`Preparing remote directory: ${remotePath}`);
    await execSsh(nodeConfig, `mkdir -p -- ${shellEscapeRemotePath(remotePath)}`, { onData: log });
    log(`Starting rsync upload for project "${projectName}"`);
    return await execRsync(
      nodeConfig,
      `${cwd}/`,
      buildRemoteProjectSource({ user: nodeConfig.user, host: nodeConfig.host, remotePath }),
      DEFAULT_PROJECT_SYNC_EXCLUDES,
      DEFAULT_PROJECT_SYNC_RSYNC_FLAGS,
      { onData: log },
    );
  }

  const hasExplicitFiles = Array.isArray(files) && files.length > 0;
  if (!hasExplicitFiles) {
    log(`Checking remote project path: ${remotePath}`);
    const exists = await remotePathExists(nodeConfig, remotePath);
    if (!exists) {
      return `Remote project directory not found: ${remotePath}`;
    }
    log(`Starting rsync download for project "${projectName}"`);
    return await execRsync(
      nodeConfig,
      buildRemoteProjectSource({ user: nodeConfig.user, host: nodeConfig.host, remotePath }),
      `${cwd}/`,
      DEFAULT_PROJECT_SYNC_DOWN_EXCLUDES,
      DEFAULT_PROJECT_SYNC_RSYNC_FLAGS,
      { onData: log },
    );
  }

  log(`Resolving ${files.length} requested remote path(s)`);
  const { existingEntries, missingEntries } = await resolveExistingRemoteSyncDownEntries(nodeConfig, {
    user: nodeConfig.user,
    host: nodeConfig.host,
    remotePath,
    files,
  });

  if (existingEntries.length === 0) {
    const missingList = missingEntries.map(entry => entry.relativePath).join(', ');
    throw new Error(`Remote files/directories not found: ${missingList}`);
  }

  log(`Starting rsync download for ${existingEntries.length} remote path(s)`);
  const output = await execRsync(
    nodeConfig,
    existingEntries.map(entry => entry.source),
    `${cwd}/`,
    DEFAULT_PROJECT_SYNC_DOWN_EXCLUDES,
    DEFAULT_PROJECT_SYNC_RSYNC_FLAGS,
    { onData: log },
  );
  if (missingEntries.length === 0) return output;

  const skippedMessage = `Skipped missing remote paths: ${missingEntries.map(entry => entry.relativePath).join(', ')}`;
  log(skippedMessage);
  return output ? `${output}\n${skippedMessage}` : skippedMessage;
}

async function runSyncTask(task) {
  const nodeConfig = await resolveNode(task.nodeId);
  task.status = 'running';
  task.startedAt = new Date().toISOString();
  appendSyncTaskLog(task, `Sync ${task.direction} started for ${task.projectName}`);

  try {
    const output = await performSync(nodeConfig, {
      direction: task.direction,
      files: task.files,
      cwd: task.cwd,
      onLog: (line) => appendSyncTaskLog(task, line),
    });

    if (output) {
      appendSyncTaskLog(task, output);
    }

    task.status = 'succeeded';
    task.result = output || `Sync ${task.direction} completed successfully.`;
    task.finishedAt = new Date().toISOString();
  } catch (error) {
    task.status = 'failed';
    task.error = error.message;
    task.finishedAt = new Date().toISOString();
    appendSyncTaskLog(task, error.message);
  } finally {
    flushSyncTaskLogs(task);
    cleanupSyncTasks();
  }
}

// ─── Main ComputeNode API ───

export const ComputeNode = {
  // Configure / save a node
  async configure({ id, name, host, user, key, password, workDir = '~', type = 'direct', slurm, port }) {
    const nodeId = id || generateId(host);
    const node = {
      id: nodeId,
      name: name || host,
      host,
      user,
      port: port || 22,
      workDir,
      type,
    };

    if (key) {
      if (key.includes('BEGIN')) {
        const keyPath = path.join(os.homedir(), '.ssh', `compute_${nodeId}_key`);
        await fs.mkdir(path.dirname(keyPath), { recursive: true });
        await fs.writeFile(keyPath, key + '\n', { mode: 0o600 });
        node.keyPath = keyPath;
      } else {
        node.keyPath = key;
      }
    } else if (password) {
      node.password = password;
    }

    if (type === 'slurm' && slurm) {
      node.slurm = slurm;
    }

    await saveNode(node);
    return `Configuration saved for ${node.user}@${node.host} (${nodeId})`;
  },

  // Sync code up/down
  async sync({ nodeId, direction = 'up', files = [], cwd, onLog }) {
    const config = await resolveNode(nodeId);
    return await performSync(config, { direction, files, cwd, onLog });
  },

  async startSyncTask({ nodeId, direction = 'up', files = [], cwd }) {
    cleanupSyncTasks();

    const config = await resolveNode(nodeId);
    const existingTask = getRunningSyncTaskForNode(config.id);
    if (existingTask) {
      throw new Error(`A sync task is already ${existingTask.status} for this node.`);
    }

    const task = {
      id: `sync-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
      nodeId: config.id,
      direction,
      cwd,
      projectName: getProjectName(cwd),
      files: Array.isArray(files) ? files : [],
      status: 'queued',
      result: null,
      error: null,
      logs: [],
      logBuffer: '',
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
    };

    syncTasks.set(task.id, task);
    cleanupSyncTasks();

    void runSyncTask(task);

    return serializeSyncTask(task, { includeLogs: true });
  },

  async listSyncTasks({ nodeId, limit = 10 }) {
    const config = await resolveNode(nodeId);
    cleanupSyncTasks();

    return [...syncTasks.values()]
      .filter(task => task.nodeId === config.id)
      .sort((a, b) => (Date.parse(b.createdAt || '') || 0) - (Date.parse(a.createdAt || '') || 0))
      .slice(0, limit)
      .map(task => serializeSyncTask(task));
  },

  async getSyncTask({ nodeId, taskId }) {
    const config = await resolveNode(nodeId);
    cleanupSyncTasks();
    const task = syncTasks.get(taskId);
    if (!task || task.nodeId !== config.id) {
      return null;
    }
    return serializeSyncTask(task, { includeLogs: true });
  },

  // Run a command on a node
  async run({ nodeId, command, cwd, skipSync = false }) {
    const config = await resolveNode(nodeId);

    if (cwd && !skipSync) {
      const projectName = getProjectName(cwd);
      const remotePath = getRemoteProjectPath(config.workDir || '~', projectName);

      await this.sync({ nodeId: config.id, direction: 'up', cwd });
      return await execSsh(config, `cd -- ${shellEscapeRemotePath(remotePath)} && ${command}`);
    } else {
      return await execSsh(config, command);
    }
  },

  // ─── Slurm-specific methods ───

  // Get partition info
  async sinfo({ nodeId }) {
    const config = await resolveNode(nodeId);
    if (config.type !== 'slurm') throw new Error('Node is not a Slurm cluster');
    const output = await execSsh(config, 'sinfo --format="%P %a %l %D %G" --noheader');
    // Parse into structured data
    const partitions = output.split('\n').filter(Boolean).map(line => {
      const parts = line.trim().split(/\s+/);
      const name = parts[0]?.replace('*', '') || '';
      const isDefault = parts[0]?.endsWith('*') || false;
      return {
        name,
        isDefault,
        available: parts[1] || '',
        timeLimit: parts[2] || '',
        nodes: parts[3] || '',
        gres: parts[4] || '',
      };
    });
    return partitions;
  },

  // Get job queue
  async squeue({ nodeId }) {
    const config = await resolveNode(nodeId);
    if (config.type !== 'slurm') throw new Error('Node is not a Slurm cluster');
    const output = await execSsh(config, `squeue -u ${config.user} --format="%i %j %P %T %M %l %D %R" --noheader`);
    if (!output.trim()) return [];
    const jobs = output.split('\n').filter(Boolean).map(line => {
      const parts = line.trim().split(/\s+/);
      return {
        jobId: parts[0] || '',
        name: parts[1] || '',
        partition: parts[2] || '',
        state: parts[3] || '',
        elapsed: parts[4] || '',
        timeLimit: parts[5] || '',
        nodes: parts[6] || '',
        reason: parts.slice(7).join(' ') || '',
      };
    });
    return jobs;
  },

  // Interactive GPU allocation (salloc + srun)
  async salloc({ nodeId, partition, time, gpus, account, command }) {
    const config = await resolveNode(nodeId);
    if (config.type !== 'slurm') throw new Error('Node is not a Slurm cluster');

    const defaults = config.slurm || {};
    const p = partition || defaults.defaultPartition;
    const t = time || defaults.defaultTime || '00:30:00';
    const g = gpus ?? defaults.defaultGpus ?? 1;
    const a = account || defaults.defaultAccount;

    let sallocCmd = 'salloc';
    if (p) sallocCmd += ` --partition=${p}`;
    sallocCmd += ` --time=${t}`;
    sallocCmd += ` --gres=gpu:${g}`;
    if (a) sallocCmd += ` -A ${a}`;

    if (command) {
      sallocCmd += ` srun ${command}`;
    }

    return await execSsh(config, sallocCmd);
  },

  // Submit batch job
  async sbatch({ nodeId, rawScript, script, partition, time, gpus, account, jobName }) {
    const config = await resolveNode(nodeId);
    if (config.type !== 'slurm') throw new Error('Node is not a Slurm cluster');

    let sbatchScript;

    if (rawScript) {
      // User provided the full script with #SBATCH directives — use as-is
      sbatchScript = rawScript;
    } else {
      // Auto-generate headers + append user script body
      const defaults = config.slurm || {};
      const p = partition || defaults.defaultPartition;
      const t = time || defaults.defaultTime || '02:00:00';
      const g = gpus ?? defaults.defaultGpus ?? 1;
      const a = account || defaults.defaultAccount;
      const name = jobName || 'dr-claw-job';

      sbatchScript = '#!/bin/bash\n';
      sbatchScript += `#SBATCH --job-name=${name}\n`;
      if (p) sbatchScript += `#SBATCH --partition=${p}\n`;
      sbatchScript += `#SBATCH --time=${t}\n`;
      sbatchScript += `#SBATCH --gres=gpu:${g}\n`;
      if (a) sbatchScript += `#SBATCH -A ${a}\n`;
      sbatchScript += `#SBATCH --output=${name}-%j.out\n`;
      sbatchScript += `#SBATCH --error=${name}-%j.err\n`;
      sbatchScript += '\n';
      sbatchScript += script;
    }

    // Write script to remote via base64 to preserve newlines and special chars
    const workDir = config.workDir || '~';
    const scriptPath = `${workDir}/.dr-claw-sbatch-${Date.now()}.sh`;
    const b64 = Buffer.from(sbatchScript).toString('base64');
    const remoteCmd = `echo '${b64}' | base64 -d > ${scriptPath} && chmod +x ${scriptPath} && sbatch ${scriptPath} && rm -f ${scriptPath}`;
    return await execSsh(config, remoteCmd);
  },

  // Cancel a job
  async scancel({ nodeId, jobId }) {
    const config = await resolveNode(nodeId);
    if (config.type !== 'slurm') throw new Error('Node is not a Slurm cluster');
    return await execSsh(config, `scancel ${jobId}`);
  },
};
