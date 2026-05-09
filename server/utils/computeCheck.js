import { exec } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import { ComputeNode, getActiveNode } from '../compute-node.js';

const execAsync = promisify(exec);

export const MIN_FREE_GPU_MB = Number.parseInt(process.env.COMPUTE_MIN_FREE_GPU_MB || '', 10) || 500;

const CMD_TIMEOUT_MS = 15_000;

/**
 * Run a shell command locally, returning stdout or '' on failure.
 * Captures stderr separately for diagnostic logging.
 */
async function runLocal(cmd) {
  try {
    const { stdout } = await execAsync(cmd, { timeout: CMD_TIMEOUT_MS });
    return stdout.trim();
  } catch (err) {
    if (err.stderr) {
      console.warn('[computeCheck] command stderr:', err.stderr.trim());
    }
    return '';
  }
}

/**
 * Escape a string so it doesn't break plain-text / markdown-ish output.
 */
function escapeGpuName(name) {
  return (name || 'Unknown').replace(/[`\\]/g, '');
}

/**
 * Parse nvidia-smi CSV output (index,name,memory.used,memory.total) into
 * a structured GPU array. Shared between local and remote checks.
 * @returns {{ gpus: Array, freeCount: number }}
 */
export function parseNvidiaSmiGpuList(csvOutput) {
  const gpus = [];
  let freeCount = 0;
  for (const line of csvOutput.split('\n')) {
    const parts = line.split(',').map(s => s.trim());
    if (parts.length >= 4) {
      const memUsed = parseFloat(parts[2]) || 0;
      const memTotal = parseFloat(parts[3]) || 0;
      const isFree = memUsed < MIN_FREE_GPU_MB;
      if (isFree) freeCount++;
      gpus.push({
        index: parseInt(parts[0]) || 0,
        name: escapeGpuName(parts[1]),
        memUsedMB: memUsed,
        memTotalMB: memTotal,
        free: isFree,
      });
    }
  }
  return { gpus, freeCount };
}

/**
 * Format a GPU list for plain-text MCP tool output.
 */
export function formatGpuLines(gpus) {
  return gpus.map(g =>
    `  GPU ${g.index}: ${g.name} — ${g.memUsedMB}/${g.memTotalMB} MiB${g.free ? ' (FREE)' : ' (BUSY)'}`,
  );
}

const FALLBACK_SUGGESTIONS = [
  'Use gpu: modal in CLAUDE.md for serverless GPU',
  'Use gpu: vast in CLAUDE.md to rent on-demand GPU',
  'Configure a remote GPU server with gpu: remote in CLAUDE.md',
];

/**
 * Check local compute availability (CUDA GPUs + macOS MPS).
 * @returns {{ available: boolean, reason: string, gpus: Array, freeCount: number, suggestions: string[], details?: string }}
 */
export async function checkLocalCompute() {
  const gpuRaw = await runLocal(
    'nvidia-smi --query-gpu=index,name,memory.used,memory.total --format=csv,noheader,nounits',
  );

  if (gpuRaw) {
    const { gpus, freeCount } = parseNvidiaSmiGpuList(gpuRaw);
    if (freeCount > 0) {
      return {
        available: true,
        reason: `${freeCount} free GPU(s) detected via CUDA`,
        gpus,
        freeCount,
        suggestions: [],
        details: formatGpuLines(gpus).join('\n'),
      };
    }
    return {
      available: false,
      reason: `All GPUs are occupied (memory.used >= ${MIN_FREE_GPU_MB} MiB on every GPU)`,
      gpus,
      freeCount: 0,
      suggestions: [
        'Free up GPU memory by stopping other processes (check with nvidia-smi)',
        ...FALLBACK_SUGGESTIONS,
      ],
      details: formatGpuLines(gpus).join('\n'),
    };
  }

  const platform = os.platform();
  if (platform === 'darwin') {
    const mpsOut = await runLocal(
      'python3 -c "import torch; print(hasattr(torch.backends, \'mps\') and torch.backends.mps.is_available())"',
    );

    if (mpsOut === 'True') {
      const gpu = { index: 0, name: 'Apple MPS', memUsedMB: 0, memTotalMB: 0, free: true };
      return {
        available: true,
        reason: 'Apple MPS (Metal Performance Shaders) available',
        gpus: [gpu],
        freeCount: 1,
        suggestions: [],
        details: '  GPU 0: Apple MPS (Metal)',
      };
    }
    return {
      available: false,
      reason: 'No GPU available — macOS without MPS support or PyTorch not installed',
      gpus: [],
      freeCount: 0,
      suggestions: [
        'Install PyTorch with MPS support: pip install torch',
        ...FALLBACK_SUGGESTIONS,
      ],
    };
  }

  return {
    available: false,
    reason: 'No GPU detected — nvidia-smi not found and not on macOS',
    gpus: [],
    freeCount: 0,
    suggestions: ['Install NVIDIA drivers and CUDA toolkit', ...FALLBACK_SUGGESTIONS],
  };
}

/**
 * Check remote compute node availability (via SSH + nvidia-smi).
 * @returns {null} if no active node is configured.
 * @returns {{ available: boolean, reason: string, details?: string, nodeName: string }}
 */
export async function checkRemoteCompute() {
  const node = await getActiveNode();
  if (!node) return null;

  const nodeName = escapeGpuName(node.name);
  try {
    const gpuOut = await ComputeNode.run({
      nodeId: node.id,
      command:
        'nvidia-smi --query-gpu=index,name,memory.used,memory.total --format=csv,noheader,nounits 2>/dev/null || echo "NO_GPU"',
      skipSync: true,
    });

    if (gpuOut.includes('NO_GPU')) {
      return { available: false, reason: `Remote node "${nodeName}" has no GPU`, nodeName };
    }

    const { gpus, freeCount } = parseNvidiaSmiGpuList(gpuOut);
    const details = formatGpuLines(gpus).join('\n');
    return {
      available: freeCount > 0,
      reason: freeCount > 0
        ? `Remote node "${nodeName}": ${freeCount} free GPU(s)`
        : `Remote node "${nodeName}": all GPUs occupied`,
      details,
      nodeName,
    };
  } catch (err) {
    console.error(`[computeCheck] Remote node "${nodeName}" SSH error:`, err.message);
    return {
      available: false,
      reason: `Remote node "${nodeName}" unreachable — check SSH connectivity and try again`,
      nodeName,
    };
  }
}

/**
 * Check Vast.ai instance availability by reading vast-instances.json or CLI.
 * @param {string} [cwd] - project directory to look for vast-instances.json
 * @returns {{ available: boolean, reason: string }}
 */
export async function checkVastCompute(cwd) {
  try {
    if (cwd) {
      const { promises: fs } = await import('fs');
      const path = await import('path');
      const instPath = path.default.join(cwd, 'vast-instances.json');
      const raw = await fs.readFile(instPath, 'utf-8');
      const instances = JSON.parse(raw);
      const running = Array.isArray(instances)
        ? instances.filter(i => i.status === 'running' || i.actual_status === 'running')
        : [];
      if (running.length > 0) {
        return { available: true, reason: `Vast.ai: ${running.length} running instance(s) found` };
      }
    }
  } catch { /* file not found or parse error — fall through */ }

  const cliOut = await runLocal('vastai show instances --raw 2>/dev/null');
  if (cliOut) {
    try {
      const instances = JSON.parse(cliOut);
      const running = Array.isArray(instances)
        ? instances.filter(i => i.actual_status === 'running')
        : [];
      if (running.length > 0) {
        return { available: true, reason: `Vast.ai: ${running.length} running instance(s)` };
      }
      return { available: false, reason: 'Vast.ai: no running instances (provision one first)' };
    } catch { /* parse error */ }
  }

  return { available: false, reason: 'Vast.ai: CLI not installed or no running instances' };
}

/**
 * Check Modal serverless compute availability.
 * @returns {{ available: boolean, reason: string }}
 */
export async function checkModalCompute() {
  const out = await runLocal('modal token verify 2>&1');
  if (out && !out.toLowerCase().includes('error') && !out.toLowerCase().includes('not found')) {
    return { available: true, reason: 'Modal: authenticated and ready (serverless — always available)' };
  }
  return { available: false, reason: 'Modal: CLI not installed or not authenticated' };
}

/**
 * Full compute availability check dispatching to the right environment.
 * @param {'local'|'remote'|'vast'|'modal'|'auto'} environment
 * @param {{ cwd?: string }} [opts]
 * @returns {{ available: boolean, reason: string, gpus?: Array, freeCount?: number, suggestions?: string[], details?: string, remoteNode?: object }}
 */
export async function checkComputeAvailability(environment = 'auto', opts = {}) {
  if (environment === 'local') return checkLocalCompute();

  if (environment === 'remote') {
    const r = await checkRemoteCompute();
    if (!r) return { available: false, reason: 'No active remote compute node configured', suggestions: FALLBACK_SUGGESTIONS, gpus: [], freeCount: 0 };
    return { ...r, gpus: [], freeCount: 0, suggestions: r.available ? [] : FALLBACK_SUGGESTIONS };
  }

  if (environment === 'vast') {
    const r = await checkVastCompute(opts.cwd);
    return { ...r, gpus: [], freeCount: 0, suggestions: r.available ? [] : FALLBACK_SUGGESTIONS };
  }

  if (environment === 'modal') {
    const r = await checkModalCompute();
    return { ...r, gpus: [], freeCount: 0, suggestions: r.available ? [] : FALLBACK_SUGGESTIONS };
  }

  // auto: remote → local, note remote availability as a suggestion if local fails
  const remote = await checkRemoteCompute();
  if (remote?.available) {
    return {
      available: true,
      reason: `${remote.reason} (remote)`,
      gpus: [],
      freeCount: 0,
      suggestions: [],
      details: remote.details,
      remoteNode: { name: remote.nodeName },
    };
  }

  const local = await checkLocalCompute();
  if (!local.available && remote) {
    local.suggestions.unshift(`An active remote compute node is configured — consider using gpu: remote`);
    local.remoteNode = { name: remote.nodeName };
  }
  return local;
}
