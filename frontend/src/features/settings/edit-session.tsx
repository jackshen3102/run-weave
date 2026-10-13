import {
  createContext,
  useContext,
  useEffect,
  useId,
  useState,
  type ReactNode,
} from "react";
import { useBlocker, useLocation } from "react-router-dom";
import { useMemoizedFn } from "ahooks";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
type Edit = { dirty: boolean; busy: boolean };
const Context = createContext<((id: string, edit: Edit | null) => void) | null>(
  null,
);
export function SettingsEditProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const [edits, setEdits] = useState<Record<string, Edit>>({});
  const register = useMemoizedFn((id: string, edit: Edit | null) =>
    setEdits((current) => {
      const next = { ...current };
      if (edit) next[id] = edit;
      else delete next[id];
      return next;
    }),
  );
  const busy = Object.values(edits).some((edit) => edit.busy);
  const dirty = Object.values(edits).some((edit) => edit.dirty);
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      currentLocation.pathname.startsWith("/settings") &&
      (busy || dirty) &&
      (currentLocation.pathname !== nextLocation.pathname ||
        currentLocation.search !== nextLocation.search),
  );
  useEffect(() => {
    if (!location.pathname.startsWith("/settings") || (!dirty && !busy)) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [busy, dirty, location.pathname]);
  return (
    <Context.Provider value={register}>
      {children}
      <Dialog
        open={blocker.state === "blocked"}
        onOpenChange={(open) => {
          if (!open && blocker.state === "blocked") blocker.reset();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {busy ? "正在处理" : dirty ? "放弃未保存的修改？" : "离开设置？"}
            </DialogTitle>
            <DialogDescription>
              {busy
                ? "操作完成后再离开，避免混淆保存目标。"
                : dirty
                  ? "离开后将恢复已保存的配置。"
                  : "操作已完成，可以继续离开。"}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => {
                if (blocker.state === "blocked") blocker.reset();
              }}
            >
              继续编辑
            </Button>
            {!busy && (
              <Button
                onClick={() => {
                  if (blocker.state === "blocked") blocker.proceed();
                }}
              >
                放弃修改并离开
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Context.Provider>
  );
}
export function useSettingsDraft(dirty: boolean, busy = false) {
  const register = useContext(Context),
    id = useId();
  useEffect(() => {
    register?.(id, { dirty, busy });
    return () => register?.(id, null);
  }, [busy, dirty, id, register]);
}
