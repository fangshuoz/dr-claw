import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  RefreshCw,
  Laptop,
  AlertCircle,
  CheckCircle2,
  Loader2,
  Plus,
  Server,
  ChevronDown,
  ChevronUp,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui/button';
import { api } from '../../utils/api';
import useLocalStorage from '../../hooks/useLocalStorage';
import { ResourceCards, SummaryCard } from './ResourceCards';
import NodeCard from './NodeCard';
import NodeForm from './NodeForm';
import type { LocalMonitorData, MonitorData, ComputeNode, NodeWithMonitor, SimpleProject } from './types';

const POLL_INTERVAL_MS = 15_000;

type LocaleKey = 'en' | 'zh' | 'ko';

function resolveLocaleKey(lang: string): LocaleKey {
  if (lang.startsWith('zh')) return 'zh';
  if (lang.startsWith('ko')) return 'ko';
  return 'en';
}

const TEXT: Record<LocaleKey, Record<string, string>> = {
  zh: {
    guideTitle: '如何使用 Compute Nodes',
    guideDesc: '只需 5 步即可配置并监控远程计算节点。',
    guideStep1: '点击右上角的"Add Node"注册新的远程计算节点。',
    guideStep2: '填写节点详情（名称、主机地址、端口）并保存。',
    guideStep3: '在目标服务器上运行提供的配置脚本建立连接。',
    guideStep4: '连接成功后，可在此仪表板实时监控 GPU 和 CPU 使用率。',
    guideStep5: '将节点设为"Active"（活动状态），即可自动将 AI 计算任务路由至该节点。',
    guideCollapse: '收起',
    guideExpand: '展开',
    guideDismiss: '不再显示',
  },
  en: {
    guideTitle: 'How to use Compute Nodes',
    guideDesc: 'Set up and monitor remote compute nodes in 5 easy steps.',
    guideStep1: "Click 'Add Node' to register a new remote compute node.",
    guideStep2: 'Fill in the node details (name, host, port) and save.',
    guideStep3: 'Run the provided configuration script on your remote server to establish a connection.',
    guideStep4: 'Once connected, monitor real-time GPU and CPU utilization directly from this dashboard.',
    guideStep5: "Set a node as 'Active' to route AI compute jobs to it automatically.",
    guideCollapse: 'Collapse',
    guideExpand: 'Expand',
    guideDismiss: 'Remove forever',
  },
  ko: {
    guideTitle: 'Compute Nodes 사용 방법',
    guideDesc: '5단계로 원격 컴퓨팅 노드를 설정하고 모니터링하세요.',
    guideStep1: "오른쪽 상단의 'Add Node'를 클릭하여 새 노드를 등록합니다.",
    guideStep2: '노드 세부 정보(이름, 호스트, 포트)를 입력하고 저장합니다.',
    guideStep3: '제공된 설정 스크립트를 원격 서버에서 실행하여 연결을 설정합니다.',
    guideStep4: '연결되면 이 대시보드에서 실시간으로 GPU 및 CPU 사용률을 모니터링할 수 있습니다.',
    guideStep5: "노드를 'Active'로 설정하면 AI 컴퓨팅 작업이 해당 노드로 자동 라우팅됩니다.",
    guideCollapse: '접기',
    guideExpand: '펼치기',
    guideDismiss: '다시 표시 안 함',
  },
};

export default function ComputeResourcesDashboard({
  selectedProject = null,
}: {
  selectedProject?: SimpleProject | null;
}) {
  const { i18n } = useTranslation();
  const locale = useMemo(() => resolveLocaleKey(i18n.language || 'en'), [i18n.language]);
  const t = TEXT[locale];

  const [guideCollapsed, setGuideCollapsed] = useLocalStorage('compute-node-guide-collapsed', false);
  const [guideDismissed, setGuideDismissed] = useLocalStorage('compute-node-guide-dismissed', false);

  // ─── State ───
  const [localData, setLocalData] = useState<LocalMonitorData | null>(null);
  const [localLoading, setLocalLoading] = useState(true);
  const [nodesData, setNodesData] = useState<NodeWithMonitor[]>([]);
  const [connectedNodeIds, setConnectedNodeIds] = useState<Set<string>>(new Set());
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [initialLoad, setInitialLoad] = useState(true);
  const [showAddForm, setShowAddForm] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ─── Data fetchers ───

  const fetchLocalMonitor = useCallback(async () => {
    try {
      const resp = await api.compute.monitorLocal();
      return (await resp.json()) as LocalMonitorData;
    } catch {
      return { success: false, gpus: [], cpu: null, error: 'Network error', timestamp: Date.now() } as LocalMonitorData;
    }
  }, []);

  const fetchNodes = useCallback(async () => {
    try {
      const resp = await api.compute.getNodes();
      const data = (await resp.json()) as { nodes: ComputeNode[]; activeNodeId?: string };
      return { nodes: data.nodes || [], activeNodeId: data.activeNodeId };
    } catch {
      return { nodes: [], activeNodeId: undefined };
    }
  }, []);

  const monitorNode = useCallback(async (nodeId: string): Promise<MonitorData> => {
    try {
      const resp = await api.compute.monitorNode(nodeId);
      return (await resp.json()) as MonitorData;
    } catch {
      return { success: false, gpus: [], cpu: null, error: 'Network error', timestamp: Date.now() };
    }
  }, []);

  // ─── Initial load (no auto-connect) ───

  const loadInitial = useCallback(async () => {
    setLocalLoading(true);
    const [localResult, { nodes, activeNodeId }] = await Promise.all([
      fetchLocalMonitor(),
      fetchNodes(),
    ]);
    setLocalData(localResult);
    setLocalLoading(false);
    setNodesData(
      nodes.map((node) => ({
        node,
        monitor: null,
        loading: false,
        isActive: node.id === activeNodeId,
      })),
    );
    setInitialLoad(false);
  }, [fetchLocalMonitor, fetchNodes]);

  // ─── Poll only connected nodes + local ───

  const pollConnected = useCallback(async () => {
    const localResult = await fetchLocalMonitor();
    setLocalData(localResult);

    if (connectedNodeIds.size > 0) {
      const results = await Promise.allSettled(
        Array.from(connectedNodeIds).map(async (nodeId) => {
          const monitor = await monitorNode(nodeId);
          return { nodeId, monitor };
        }),
      );
      setNodesData((prev) =>
        prev.map((item) => {
          const result = results.find(
            (r) => r.status === 'fulfilled' && r.value.nodeId === item.node.id,
          );
          if (result?.status === 'fulfilled') {
            return { ...item, monitor: result.value.monitor, loading: false };
          }
          return item;
        }),
      );
    }
  }, [connectedNodeIds, fetchLocalMonitor, monitorNode]);

  // ─── Connect / Disconnect ───

  const connectNode = useCallback(
    async (nodeId: string) => {
      setConnectedNodeIds((prev) => new Set(prev).add(nodeId));
      setNodesData((prev) =>
        prev.map((item) =>
          item.node.id === nodeId ? { ...item, loading: true } : item,
        ),
      );
      const monitor = await monitorNode(nodeId);
      setNodesData((prev) =>
        prev.map((item) =>
          item.node.id === nodeId ? { ...item, monitor, loading: false } : item,
        ),
      );
    },
    [monitorNode],
  );

  const disconnectNode = useCallback((nodeId: string) => {
    setConnectedNodeIds((prev) => {
      const next = new Set(prev);
      next.delete(nodeId);
      return next;
    });
    setNodesData((prev) =>
      prev.map((item) =>
        item.node.id === nodeId ? { ...item, monitor: null, loading: false } : item,
      ),
    );
  }, []);

  // ─── Node CRUD ───

  const reloadNodes = useCallback(async () => {
    const { nodes, activeNodeId } = await fetchNodes();
    setNodesData((prev) =>
      nodes.map((node) => {
        const existing = prev.find((d) => d.node.id === node.id);
        return {
          node,
          monitor: connectedNodeIds.has(node.id) ? (existing?.monitor ?? null) : null,
          loading: false,
          isActive: node.id === activeNodeId,
        };
      }),
    );
  }, [fetchNodes, connectedNodeIds]);

  const handleSetActive = useCallback(
    async (nodeId: string) => {
      await api.compute.setActive(nodeId);
      await reloadNodes();
    },
    [reloadNodes],
  );

  const handleDeleteNode = useCallback(
    async (nodeId: string) => {
      try {
        await api.compute.deleteNode(nodeId);
      } catch {
        // ignore
      }
      setConnectedNodeIds((prev) => {
        const next = new Set(prev);
        next.delete(nodeId);
        return next;
      });
      setNodesData((prev) => prev.filter((item) => item.node.id !== nodeId));
    },
    [],
  );

  // ─── Refresh (manual) ───

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    setLocalLoading(true);
    try {
      const localResult = await fetchLocalMonitor();
      setLocalData(localResult);
      setLocalLoading(false);
      await reloadNodes();
      // Re-poll connected nodes
      if (connectedNodeIds.size > 0) {
        const results = await Promise.allSettled(
          Array.from(connectedNodeIds).map(async (id) => {
            const monitor = await monitorNode(id);
            return { nodeId: id, monitor };
          }),
        );
        setNodesData((prev) =>
          prev.map((item) => {
            const result = results.find(
              (r) => r.status === 'fulfilled' && r.value.nodeId === item.node.id,
            );
            if (result?.status === 'fulfilled') {
              return { ...item, monitor: result.value.monitor };
            }
            return item;
          }),
        );
      }
    } finally {
      setIsRefreshing(false);
    }
  }, [connectedNodeIds, fetchLocalMonitor, monitorNode, reloadNodes]);

  // ─── Effects ───

  const loadInitialRef = useRef(loadInitial);
  loadInitialRef.current = loadInitial;

  useEffect(() => {
    void loadInitialRef.current();
  }, []);

  const pollConnectedRef = useRef(pollConnected);
  pollConnectedRef.current = pollConnected;

  useEffect(() => {
    if (initialLoad) return;
    pollRef.current = setInterval(() => {
      void pollConnectedRef.current();
    }, POLL_INTERVAL_MS);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [connectedNodeIds, initialLoad]);

  // ─── Aggregated stats ───

  const allMonitors = [
    localData,
    ...nodesData.filter((d) => connectedNodeIds.has(d.node.id)).map((d) => d.monitor),
  ].filter((m): m is MonitorData => !!m && m.success);

  const totalGpus = allMonitors.reduce((n, m) => n + m.gpus.length, 0);
  const activeGpus = allMonitors.reduce(
    (n, m) => n + m.gpus.filter((g) => g.gpuUtil > 5 || g.memUtil > 5).length,
    0,
  );
  const totalCpuCores = allMonitors.reduce((n, m) => n + (m.cpu?.cores ?? 0), 0);
  const cpuMonitors = allMonitors.filter((m) => m.cpu);
  const avgCpuUtil =
    cpuMonitors.length > 0
      ? Math.round(cpuMonitors.reduce((s, m) => s + m.cpu!.utilPercent, 0) / cpuMonitors.length)
      : 0;

  const connectedCount = connectedNodeIds.size;

  // ─── Render ───

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-6xl mx-auto p-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Compute Resources</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Monitor GPU and CPU usage across your compute nodes
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="rounded-xl"
              onClick={() => setShowAddForm(true)}
              disabled={showAddForm}
            >
              <Plus className="h-3.5 w-3.5 mr-1.5" />
              Add Node
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="rounded-xl"
              onClick={() => void handleRefresh()}
              disabled={isRefreshing}
            >
              <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${isRefreshing ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          </div>
        </div>

        {/* Usage guide */}
        {!guideDismissed && (
          <div className="relative overflow-hidden rounded-[28px] border border-sky-200/70 bg-[radial-gradient(circle_at_top_left,rgba(125,211,252,0.24),transparent_38%),linear-gradient(180deg,rgba(248,250,252,0.96),rgba(239,246,255,0.94))] p-5 shadow-sm dark:border-sky-900/70 dark:bg-[radial-gradient(circle_at_top_left,rgba(56,189,248,0.18),transparent_38%),linear-gradient(180deg,rgba(15,23,42,0.96),rgba(2,6,23,0.94))]">
            <div className="absolute -right-10 -top-8 h-28 w-28 rounded-full bg-sky-200/40 blur-3xl dark:bg-sky-500/10" />
            <div className="relative flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex min-w-0 items-start gap-3">
                <div className="relative flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-2xl border border-sky-200/80 bg-white/80 text-sky-700 shadow-sm dark:border-sky-900/70 dark:bg-slate-950/50 dark:text-sky-300">
                  <AlertCircle className="w-5 h-5" />
                </div>
                <div className="min-w-0">
                  <h3 className="text-base font-semibold tracking-tight text-slate-900 dark:text-sky-100">
                    {t.guideTitle}
                  </h3>
                  {!guideCollapsed ? (
                    <p className="mt-1 text-sm leading-6 text-slate-700 dark:text-sky-100/85">
                      {t.guideDesc}
                    </p>
                  ) : (
                    <p className="mt-1 text-xs text-slate-600 dark:text-sky-100/70">
                      {locale === 'zh' ? '教程已折叠，点击展开查看。' : 'Guide hidden. Expand to view steps.'}
                    </p>
                  )}
                </div>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
                <button
                  type="button"
                  className="inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-medium text-slate-700 hover:bg-sky-100/60 hover:text-slate-900 dark:text-sky-100/80 dark:hover:bg-sky-900/30 dark:hover:text-sky-100"
                  onClick={() => setGuideCollapsed(!guideCollapsed)}
                >
                  {guideCollapsed ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
                  {guideCollapsed ? t.guideExpand : t.guideCollapse}
                </button>
                <button
                  type="button"
                  className="inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-medium text-slate-700 hover:bg-sky-100/60 hover:text-slate-900 dark:text-sky-100/80 dark:hover:bg-sky-900/30 dark:hover:text-sky-100"
                  onClick={() => setGuideDismissed(true)}
                >
                  <X className="h-4 w-4" />
                  {t.guideDismiss}
                </button>
              </div>
            </div>
            {!guideCollapsed && (
              <div className="relative mt-4 space-y-3 pl-14">
                <ol className="list-decimal pl-4 space-y-1.5 text-sm text-slate-700 dark:text-sky-100/85">
                  {(['guideStep1', 'guideStep2', 'guideStep3', 'guideStep4', 'guideStep5'] as const).map((key) => (
                    <li key={key}>{t[key]}</li>
                  ))}
                </ol>
              </div>
            )}
          </div>
        )}

        {initialLoad ? (
          <div className="flex items-center justify-center py-20 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin mr-2" />
            Loading compute resources...
          </div>
        ) : (
          <>
            {/* Summary cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <SummaryCard
                label="Nodes"
                value={1 + nodesData.length}
                sublabel={
                  nodesData.length > 0
                    ? `(1 local + ${nodesData.length} remote${connectedCount > 0 ? `, ${connectedCount} connected` : ''})`
                    : '(local)'
                }
              />
              <SummaryCard
                label="GPUs"
                value={totalGpus > 0 ? `${activeGpus} / ${totalGpus}` : '0'}
                sublabel={totalGpus > 0 ? 'in use' : 'detected'}
              />
              <SummaryCard label="CPU Cores" value={totalCpuCores} />
              <SummaryCard label="Avg CPU Load" value={`${avgCpuUtil}%`} />
            </div>

            {/* Local machine */}
            <div className="space-y-4">
              <div className="flex items-center gap-3 flex-wrap">
                <div className="flex items-center gap-2">
                  <Laptop className="h-4 w-4 text-muted-foreground" />
                  <h3 className="text-base font-semibold">
                    {localData?.hostname || 'Local Machine'}
                  </h3>
                </div>
                <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300 font-medium">
                  This Machine
                </span>
                {localData?.platform && (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
                    {localData.platform === 'darwin' ? 'macOS' : localData.platform === 'win32' ? 'Windows' : 'Linux'}
                  </span>
                )}
                {localLoading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
              </div>

              {localData && !localData.success && (
                <div className="flex items-center gap-2 text-sm text-destructive bg-destructive/10 rounded-lg px-3 py-2">
                  <AlertCircle className="h-4 w-4 flex-shrink-0" />
                  <span>{localData.error || 'Failed to read local stats'}</span>
                </div>
              )}

              {localData?.success && (localData.cpu || localData.gpus.length > 0) && (
                <ResourceCards monitor={localData} />
              )}

              {localData?.success && !localData.cpu && localData.gpus.length === 0 && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground bg-muted/40 rounded-lg px-3 py-2">
                  <CheckCircle2 className="h-4 w-4 flex-shrink-0" />
                  <span>No GPU detected on this machine</span>
                </div>
              )}
            </div>

            {/* Remote nodes */}
            <div className="border-t pt-4">
              <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-4">
                Remote Nodes
                {nodesData.length > 0 && (
                  <span className="font-normal ml-2">
                    ({connectedCount} of {nodesData.length} connected)
                  </span>
                )}
              </h2>
            </div>

            {/* Add node form */}
            {showAddForm && (
              <NodeForm
                onSave={() => { setShowAddForm(false); void reloadNodes(); }}
                onCancel={() => setShowAddForm(false)}
              />
            )}

            {/* Node cards */}
            {nodesData.length > 0 ? (
              <div className="space-y-4">
                {nodesData.map((data) => (
                  <NodeCard
                    key={data.node.id}
                    data={data}
                    selectedProject={selectedProject}
                    isConnected={connectedNodeIds.has(data.node.id)}
                    onConnect={() => void connectNode(data.node.id)}
                    onDisconnect={() => disconnectNode(data.node.id)}
                    onDelete={() => void handleDeleteNode(data.node.id)}
                    onNodeUpdated={() => void reloadNodes()}
                    onSetActive={() => void handleSetActive(data.node.id)}
                  />
                ))}
              </div>
            ) : (
              !showAddForm && (
                <div className="flex flex-col items-center justify-center py-10 text-muted-foreground">
                  <Server className="h-8 w-8 mb-3 opacity-40" />
                  <p className="text-sm">No remote nodes configured</p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="rounded-xl mt-3"
                    onClick={() => setShowAddForm(true)}
                  >
                    <Plus className="h-3.5 w-3.5 mr-1.5" />
                    Add your first node
                  </Button>
                </div>
              )
            )}

            {/* Timestamp */}
            {connectedCount > 0 && (
              <p className="text-xs text-muted-foreground text-center pt-2">
                Auto-refreshes every {POLL_INTERVAL_MS / 1000}s for connected nodes
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
