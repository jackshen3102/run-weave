import { useQueries } from "@tanstack/react-query";
import { useTerminalProjectsQuery } from "../terminal/queries/workspace";
import { useTerminalRuntime } from "../terminal/queries/provider";
import { terminalQueryKeys } from "../terminal/queries/keys";
import { listTerminalProjectContexts } from "../../services/terminal/projects";
import { fieldClass, RequestError } from "./presentation";

export function TaskProjectSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (projectId: string) => void;
}) {
  const { apiBase, token, scope } = useTerminalRuntime();
  const projects = useTerminalProjectsQuery();
  const contexts = useQueries({
    queries: (projects.data ?? []).map((project) => ({
      queryKey: terminalQueryKeys.projectContexts(scope, project.projectId),
      queryFn: () =>
        listTerminalProjectContexts(apiBase, token, project.projectId),
    })),
  });
  const options = (projects.data ?? []).flatMap((project, index) => {
    const children = contexts[index]?.data ?? [];
    return [
      {
        id: project.projectId,
        label: project.name,
        disabled:
          children.find((item) => item.isPrimary)?.availability ===
          "path_unavailable",
      },
      ...children
        .filter((item) => !item.isPrimary)
        .map((item) => ({
          id: item.projectId,
          label: `${project.name} / ${item.name}`,
          disabled: item.availability !== "available",
        })),
    ];
  });
  return (
    <div className="grid gap-2">
      <label className="grid gap-1 text-sm">
        项目
        <select
          className={fieldClass}
          required
          value={value}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="" disabled>
            选择项目
          </option>
          {value && !options.some((item) => item.id === value) ? (
            <option value={value} disabled>
              {value}（待校验）
            </option>
          ) : null}
          {options.map((item) => (
            <option key={item.id} value={item.id} disabled={item.disabled}>
              {item.label}
              {item.disabled ? "（目录不可用）" : ""}
            </option>
          ))}
        </select>
      </label>
      <RequestError
        error={projects.error ?? contexts.find((item) => item.error)?.error}
      />
    </div>
  );
}
