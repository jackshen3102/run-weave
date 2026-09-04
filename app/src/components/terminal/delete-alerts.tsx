import { IonAlert } from "@ionic/react";

interface AppTerminalDeleteAlertsProps {
  confirmDeleteOpen: boolean;
  deleteError: string | null;
  isDeletingTerminal: boolean;
  onConfirmDelete: () => void;
  onDismissConfirm: () => void;
  onDismissError: () => void;
}

export function AppTerminalDeleteAlerts({
  confirmDeleteOpen,
  deleteError,
  isDeletingTerminal,
  onConfirmDelete,
  onDismissConfirm,
  onDismissError,
}: AppTerminalDeleteAlertsProps) {
  return (
    <>
      <IonAlert
        buttons={[
          {
            role: "cancel",
            text: "取消",
          },
          {
            cssClass: "terminal-delete-alert__confirm",
            handler: () => {
              onConfirmDelete();
              return false;
            },
            role: "destructive",
            text: isDeletingTerminal ? "删除中..." : "删除",
          },
        ]}
        header="删除终端"
        isOpen={confirmDeleteOpen}
        message="删除后会关闭这个终端会话，并清除对应历史。"
        onDidDismiss={onDismissConfirm}
      />
      <IonAlert
        buttons={["确定"]}
        header="删除失败"
        isOpen={deleteError !== null}
        message={deleteError ?? ""}
        onDidDismiss={onDismissError}
      />
    </>
  );
}
