import { useState, useSyncExternalStore } from "react";
import { onlineManager } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import { useDebounce } from "ahooks";
import { ArrowLeft, CalendarClock, MoreHorizontal, Plus } from "lucide-react";
import type { ScheduledTask } from "@runweave/shared/scheduled-tasks";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { ConnectionSwitcher } from "../components/connection-switcher";
import type { ConnectionConfig } from "../features/connection/types";
import { TerminalRuntimeProvider } from "../features/terminal/queries/provider";
import { useTerminalProjectsQuery } from "../features/terminal/queries/workspace";
import { buildConnectionQueryScope } from "../features/query/connection-query-provider";
import { useTaskNavigation } from "../features/scheduled-tasks/navigation";
import { useCapabilities, useTasks } from "../features/scheduled-tasks/queries";
import {
  fieldClass,
  RequestError,
} from "../features/scheduled-tasks/presentation";
import { TaskList } from "../features/scheduled-tasks/task-list";
import { TaskDetail } from "../features/scheduled-tasks/task-detail";
import { TaskEditor } from "../features/scheduled-tasks/task-editor";

interface Props {
  apiBase: string;
  token: string;
  activeConnectionId: string | null;
  connectionName?: string;
  connections: ConnectionConfig[];
  onSelectConnection?: (id: string) => void;
  onOpenConnectionManager?: () => void;
}
export function ScheduledTasksPage(props: Props) {
  const scope = buildConnectionQueryScope({
    apiBase: props.apiBase,
    connectionId: props.activeConnectionId,
  });
  return (
    <TerminalRuntimeProvider
      apiBase={props.apiBase}
      token={props.token}
      activeConnectionId={props.activeConnectionId}
    >
      <ScheduledTasksContent key={scope} {...props} />
    </TerminalRuntimeProvider>
  );
}
function ScheduledTasksContent(props: Props) {
  const online = useSyncExternalStore(
    (notify) => onlineManager.subscribe(notify),
    () => onlineManager.isOnline(),
  );
  const { taskId } = useParams<{ taskId: string }>();
  const { workspace, go, back } = useTaskNavigation();
  const [parentId, setParentId] = useState(workspace.parentProjectId ?? "");
  const [archived, setArchived] = useState(false);
  const [search, setSearch] = useState("");
  const query = useDebounce(search, { wait: 250 });
  const [editor, setEditor] = useState<ScheduledTask | "new" | null>(null);
  const capabilities = useCapabilities();
  const projects = useTerminalProjectsQuery();
  const available = Boolean(capabilities.data) && !capabilities.isError;
  const tasks = useTasks(
    { parentProjectId: parentId || undefined, archived, q: query },
    available && !taskId,
  );
  const records = tasks.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <main className="min-h-dvh bg-background text-foreground">
      <header className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b bg-background/95 px-4 py-3 backdrop-blur">
        <Button variant="ghost" size="sm" onClick={back}>
          <ArrowLeft className="mr-1 h-4 w-4" />
          返回工作区
        </Button>
        <CalendarClock className="h-4 w-4" />
        <h1 className="font-semibold">定时任务</h1>
        <div className="ml-auto">
          {props.activeConnectionId &&
          props.onSelectConnection &&
          props.onOpenConnectionManager ? (
            <ConnectionSwitcher
              connections={props.connections}
              activeConnectionId={props.activeConnectionId}
              activeConnectionName={props.connectionName}
              onSelectConnection={(id) => {
                go("/scheduled-tasks");
                props.onSelectConnection?.(id);
              }}
              onOpenConnectionManager={props.onOpenConnectionManager}
            />
          ) : (
            <span className="text-xs text-muted-foreground">
              {props.connectionName ?? "当前 Backend"}
            </span>
          )}
        </div>
      </header>
      <div className="mx-auto max-w-5xl space-y-5 px-4 py-6">
        {!online ? (
          <p role="alert" className="text-sm text-destructive">
            网络已断开，等待连接恢复。未提交的草稿会保留。
          </p>
        ) : null}
        <RequestError error={capabilities.error} />
        {capabilities.isPending ? <p>正在检查定时任务能力…</p> : null}
        {capabilities.data && !capabilities.data.enabled ? (
          <p role="status">
            {capabilities.data.reason ??
              "当前 Backend 未启用定时任务，请检查服务配置。"}
          </p>
        ) : null}
        {capabilities.isError ? (
          <Button
            variant="outline"
            onClick={() => {
              void capabilities.refetch();
            }}
          >
            重试连接
          </Button>
        ) : null}
        {available ? (
          <>
            {taskId ? (
              <>
                <Button variant="ghost" onClick={() => go("/scheduled-tasks")}>
                  <ArrowLeft className="mr-2 h-4 w-4" />
                  任务列表
                </Button>
                <TaskDetail
                  key={taskId}
                  taskId={taskId}
                  onEdit={setEditor}
                  readOnly={!capabilities.data?.enabled}
                />
              </>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-3">
                  <h2 className="mr-auto text-xl font-semibold">
                    {archived ? "已删除任务" : "我的任务"}
                  </h2>
                  <Button
                    disabled={!capabilities.data?.enabled}
                    onClick={() => setEditor("new")}
                  >
                    <Plus className="mr-1 h-4 w-4" />
                    新建任务
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="outline"
                        size="icon"
                        aria-label="列表更多操作"
                      >
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent>
                      <DropdownMenuItem
                        onSelect={() => setArchived((value) => !value)}
                      >
                        {archived ? "当前任务" : "已删除任务"}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Input
                    aria-label="搜索任务"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="搜索任务"
                  />
                  <select
                    aria-label="项目筛选"
                    className={fieldClass}
                    value={parentId}
                    onChange={(e) => setParentId(e.target.value)}
                  >
                    <option value="">所有项目</option>
                    {projects.data?.map((project) => (
                      <option key={project.projectId} value={project.projectId}>
                        {project.name}
                      </option>
                    ))}
                  </select>
                </div>
                <RequestError error={projects.error ?? tasks.error} />
                {tasks.isPending ? <p>正在加载任务…</p> : null}
                {!tasks.isPending && !tasks.error && !records.length ? (
                  <div className="rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">
                    {archived ? "没有已删除的任务" : "还没有符合条件的任务"}
                  </div>
                ) : null}
                <TaskList
                  tasks={records}
                  onOpen={(id) =>
                    go(`/scheduled-tasks/${encodeURIComponent(id)}`)
                  }
                  onEdit={setEditor}
                  readOnly={!capabilities.data?.enabled}
                />
                {tasks.hasNextPage ? (
                  <Button
                    variant="outline"
                    disabled={tasks.isFetchingNextPage}
                    onClick={() => {
                      void tasks.fetchNextPage();
                    }}
                  >
                    加载更多任务
                  </Button>
                ) : null}
              </>
            )}
          </>
        ) : null}
      </div>
      {editor && capabilities.data ? (
        <TaskEditor
          task={editor === "new" ? undefined : editor}
          defaultProjectId={workspace.projectId ?? ""}
          capabilities={capabilities.data}
          onClose={() => setEditor(null)}
          onSaved={(task) => {
            setEditor(null);
            go(`/scheduled-tasks/${encodeURIComponent(task.id)}`);
          }}
        />
      ) : null}
    </main>
  );
}
