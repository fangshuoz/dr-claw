import { useEffect, useRef } from 'react';
import { CheckCircle, Clock, Loader2, RefreshCw, XCircle } from 'lucide-react';
import { Button } from '../ui/button';
import type { SyncTask } from './types';

const getSyncTaskStatusMeta = (status: string) => {
  if (status === 'running') {
    return {
      label: 'Running',
      tone: 'text-blue-700 dark:text-blue-300 bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800',
      icon: Loader2,
      spin: true,
    };
  }
  if (status === 'queued') {
    return {
      label: 'Queued',
      tone: 'text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800',
      icon: Clock,
      spin: false,
    };
  }
  if (status === 'succeeded') {
    return {
      label: 'Succeeded',
      tone: 'text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-900/20 border-emerald-200 dark:border-emerald-800',
      icon: CheckCircle,
      spin: false,
    };
  }
  return {
    label: 'Failed',
    tone: 'text-destructive bg-destructive/10 border-destructive/20',
    icon: XCircle,
    spin: false,
  };
};

const formatTaskTime = (value?: string | null) => {
  if (!value) return null;
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return null;
  return new Date(timestamp).toLocaleString();
};

export default function SyncTaskPanel({
  task,
  tasks,
  isRefreshing,
  onRefresh,
  onSelectTask,
}: {
  task: SyncTask | null;
  tasks: SyncTask[];
  isRefreshing: boolean;
  onRefresh: () => void;
  onSelectTask: (taskId: string) => void;
}) {
  const logEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ block: 'end' });
  }, [task?.logs?.length]);

  if (!task && tasks.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-muted/20 p-3 text-xs text-muted-foreground">
        Background sync logs will appear here after you start a project sync.
      </div>
    );
  }

  const currentTask = task || tasks[0];
  const statusMeta = getSyncTaskStatusMeta(currentTask?.status || '');
  const StatusIcon = statusMeta.icon;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs text-muted-foreground">Background sync status and logs</div>
        <Button variant="ghost" size="sm" className="h-7 rounded-xl px-2" onClick={onRefresh} disabled={isRefreshing}>
          <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      {currentTask && (
        <div className="rounded-xl border bg-muted/20 p-3 space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-medium">
                {currentTask.direction === 'down' ? 'Sync Down' : 'Sync Up'}
                {currentTask.projectName ? ` · ${currentTask.projectName}` : ''}
              </div>
              <div className="mt-1 text-[11px] text-muted-foreground">
                {formatTaskTime(currentTask.startedAt || currentTask.createdAt) || 'Waiting to start'}
                {currentTask.finishedAt ? ` -> ${formatTaskTime(currentTask.finishedAt) || 'Completed'}` : ''}
              </div>
            </div>
            <div className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] font-medium ${statusMeta.tone}`}>
              <StatusIcon className={`w-3 h-3 ${statusMeta.spin ? 'animate-spin' : ''}`} />
              {statusMeta.label}
            </div>
          </div>

          <div className="rounded-lg border bg-background/80 p-2">
            <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-[11px] leading-5 text-foreground">
              {currentTask.logs && currentTask.logs.length > 0
                ? currentTask.logs.join('\n')
                : currentTask.result || currentTask.error || 'Waiting for sync logs...'}
            </pre>
            <div ref={logEndRef} />
          </div>
        </div>
      )}

      {tasks.length > 1 && (
        <div className="space-y-1">
          <div className="text-[11px] text-muted-foreground">Recent sync tasks</div>
          {tasks.map((item) => {
            const itemStatus = getSyncTaskStatusMeta(item.status);
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelectTask(item.id)}
                className={`w-full rounded-xl border px-2.5 py-2 text-left text-xs transition-colors ${
                  currentTask?.id === item.id
                    ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                    : 'border-border bg-background hover:border-muted-foreground/40'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-foreground">
                    {item.direction === 'down' ? 'Sync Down' : 'Sync Up'}
                    {item.projectName ? ` · ${item.projectName}` : ''}
                  </span>
                  <span className="text-muted-foreground">{itemStatus.label}</span>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
