import {
  IonButton,
  IonContent,
  IonInput,
  IonModal,
  IonText,
} from "@ionic/react";
import { type FormEvent, useMemo, useState } from "react";

import type { AppConnectionConfig } from "../features/connections/types";
import { getBackendHealth } from "../services/device-health";
import { useAppConnectionStore } from "../store/use-app-connection-store";
import { AppConnectionChip, getAppConnectionHostLabel } from "./AppConnectionChip";

interface AppConnectionManagerProps {
  isOpen: boolean;
  onDidDismiss: () => void;
  onActiveConnectionChanged?: (connection: AppConnectionConfig) => void;
}

function connectionStatusLabel(connection: AppConnectionConfig): string {
  if (connection.available === true) {
    return connection.statusMessage ?? "Online";
  }
  if (connection.available === false) {
    return connection.statusMessage ?? "Unavailable";
  }
  return connection.statusMessage ?? "Not checked";
}

function defaultNameForUrl(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "Runweave backend";
  }
}

function resolveHealthStatusMessage(result: Awaited<ReturnType<typeof getBackendHealth>>): string {
  if (result.ok) {
    return `Online · ${result.latencyMs}ms`;
  }
  if (result.failure?.kind === "timeout") {
    return "Health check timed out";
  }
  if (result.failure?.kind === "http-error") {
    return `HTTP ${result.failure.status ?? "error"}`;
  }
  return "Cannot reach backend";
}

export function AppConnectionManager({
  isOpen,
  onActiveConnectionChanged,
  onDidDismiss,
}: AppConnectionManagerProps) {
  const {
    activeId,
    activeConnection,
    addConnection,
    connections,
    removeConnection,
    selectConnection,
    updateConnection,
  } = useAppConnectionStore();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [checkingId, setCheckingId] = useState<string | null>(null);
  const editingConnection = useMemo(
    () => connections.find((connection) => connection.id === editingId) ?? null,
    [connections, editingId],
  );
  const isEditing = Boolean(editingConnection);

  const resetForm = () => {
    setEditingId(null);
    setName("");
    setUrl("");
    setFormError(null);
  };

  const startEdit = (connection: AppConnectionConfig) => {
    setEditingId(connection.id);
    setName(connection.name);
    setUrl(connection.url);
    setFormError(null);
  };

  const handleSelect = (connection: AppConnectionConfig) => {
    const changed = connection.id !== activeId;
    selectConnection(connection.id);
    if (changed) {
      onActiveConnectionChanged?.(connection);
    }
  };

  const handleCheck = async (connection: AppConnectionConfig) => {
    setCheckingId(connection.id);
    try {
      const result = await getBackendHealth(connection.url, { timeoutMs: 2500 });
      updateConnection(connection.id, {
        available: result.ok,
        statusMessage: resolveHealthStatusMessage(result),
      });
    } finally {
      setCheckingId(null);
    }
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    setFormError(null);

    try {
      if (isEditing && editingConnection) {
        updateConnection(editingConnection.id, {
          name,
          url,
          available: undefined,
          statusMessage: "Not checked",
        });
      } else {
        const connection = addConnection({
          name: name.trim() || defaultNameForUrl(url.trim()),
          url,
        });
        onActiveConnectionChanged?.(connection);
      }
      resetForm();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "连接保存失败");
    }
  };

  const handleRemove = (connection: AppConnectionConfig) => {
    const nextConnection = connections.find(
      (candidate) =>
        candidate.id !== connection.id && candidate.canDelete !== false,
    ) ?? connections.find((candidate) => candidate.id !== connection.id);
    removeConnection(connection.id);
    if (connection.id === activeId && nextConnection) {
      onActiveConnectionChanged?.(nextConnection);
    }
    if (editingId === connection.id) {
      resetForm();
    }
  };

  return (
    <IonModal
      className="app-connection-manager"
      isOpen={isOpen}
      onDidDismiss={onDidDismiss}
    >
      <IonContent className="app-connection-manager__content">
        <section className="app-connection-manager__sheet">
          <header className="app-connection-manager__header">
            <div>
              <p>Backend</p>
              <h2>连接管理</h2>
            </div>
            <button onClick={onDidDismiss} type="button">
              关闭
            </button>
          </header>

          <div className="app-connection-manager__active">
            <AppConnectionChip
              connection={activeConnection}
              disabled
              onClick={() => undefined}
            />
          </div>

          <div className="app-connection-list">
            {connections.map((connection) => (
              <article
                className={[
                  "app-connection-row",
                  connection.id === activeId ? "is-active" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                key={connection.id}
              >
                <button
                  className="app-connection-row__main"
                  onClick={() => handleSelect(connection)}
                  type="button"
                >
                  <span className="app-connection-row__title">
                    {connection.name}
                  </span>
                  <span className="app-connection-row__host">
                    {getAppConnectionHostLabel(connection)}
                  </span>
                  <span
                    className={[
                      "app-connection-row__status",
                      connection.available === true ? "is-online" : "",
                      connection.available === false ? "is-offline" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                  >
                    {connectionStatusLabel(connection)}
                  </span>
                </button>
                <div className="app-connection-row__actions">
                  <button
                    disabled={checkingId === connection.id}
                    onClick={() => void handleCheck(connection)}
                    type="button"
                  >
                    {checkingId === connection.id ? "检测中" : "检测"}
                  </button>
                  {connection.canEdit !== false ? (
                    <button onClick={() => startEdit(connection)} type="button">
                      编辑
                    </button>
                  ) : null}
                  {connection.canDelete !== false ? (
                    <button
                      className="is-danger"
                      onClick={() => handleRemove(connection)}
                      type="button"
                    >
                      删除
                    </button>
                  ) : null}
                </div>
              </article>
            ))}
            {connections.length === 0 ? (
              <p className="app-connection-list__empty">
                先添加一个 Runweave 后端连接。
              </p>
            ) : null}
          </div>

          <form className="app-connection-form" onSubmit={handleSubmit}>
            <h3>{isEditing ? "编辑连接" : "新增连接"}</h3>
            <IonInput
              className="app-input"
              label="名称"
              labelPlacement="stacked"
              onIonInput={(event) => setName(String(event.detail.value ?? ""))}
              placeholder="Office Mac"
              value={name}
            />
            <IonInput
              className="app-input"
              label="URL"
              labelPlacement="stacked"
              onIonInput={(event) => setUrl(String(event.detail.value ?? ""))}
              placeholder="http://localhost:5001"
              value={url}
            />
            {formError ? (
              <IonText color="danger">
                <p className="app-connection-form__error">{formError}</p>
              </IonText>
            ) : null}
            <div className="app-connection-form__actions">
              {isEditing ? (
                <button onClick={resetForm} type="button">
                  取消
                </button>
              ) : null}
              <IonButton
                className="app-connection-form__submit"
                disabled={!url.trim()}
                type="submit"
              >
                {isEditing ? "保存" : "添加并切换"}
              </IonButton>
            </div>
          </form>
        </section>
      </IonContent>
    </IonModal>
  );
}
