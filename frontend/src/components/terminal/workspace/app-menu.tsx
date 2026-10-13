import { useSettingsNavigation } from "../../../features/settings/navigation";
import { appNavigationItems } from "../../../features/settings/registry";
import { useMemoizedFn } from "ahooks";
import { LockKeyhole, LogOut, Menu, Plus } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ThemeToggle } from "../../theme-toggle";
import { Button } from "../../ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "../../ui/sheet";
import { useTerminalRuntime } from "../../../features/terminal/queries/provider";
import { ChangePasswordDialog } from "./change-password-dialog";

interface TerminalAppMenuProps {
  isMobileMonitor: boolean;
  loading: boolean;
  onCreateSession: () => void;
}

export function TerminalAppMenu({
  isMobileMonitor,
  loading,
  onCreateSession,
}: TerminalAppMenuProps) {
  const openSettings = useSettingsNavigation();
  if (!isMobileMonitor) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-label="全局设置"
        title="全局设置"
        className="h-6 w-6 shrink-0 rounded-md px-0 text-slate-300 hover:bg-slate-800 hover:text-slate-100"
        onClick={() => openSettings()}
      >
        <Menu className="h-3.5 w-3.5" />
      </Button>
    );
  }
  return <MobileAppMenu loading={loading} onCreateSession={onCreateSession} />;
}

function MobileAppMenu({
  loading,
  onCreateSession,
}: Omit<TerminalAppMenuProps, "isMobileMonitor">) {
  const navigate = useNavigate();
  const { onAuthExpired } = useTerminalRuntime();
  const [open, setOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const goTo = useMemoizedFn((path: string) => {
    setOpen(false);
    navigate(path);
  });

  return (
    <>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label="应用菜单"
            title="应用菜单"
            className="h-6 w-6 shrink-0 rounded-md px-0 text-slate-300 hover:bg-slate-800 hover:text-slate-100"
          >
            <Menu className="h-3.5 w-3.5" />
          </Button>
        </SheetTrigger>
        <SheetContent
          side="left"
          className="dark w-full max-w-none overflow-y-auto border-slate-800 bg-slate-950 text-slate-100"
        >
          <SheetHeader>
            <SheetTitle>应用菜单</SheetTitle>
            <SheetDescription>导航与账户设置</SheetDescription>
          </SheetHeader>
          <div className="mt-4 flex flex-col gap-2">
            <Button
              type="button"
              disabled={loading}
              className="justify-start"
              onClick={() => {
                setOpen(false);
                onCreateSession();
              }}
            >
              <Plus className="mr-2 h-4 w-4" />
              新建终端
            </Button>
            <p className="mt-2 text-xs text-slate-400">导航</p>
            {appNavigationItems.map((item) => (
              <Button
                key={item.path}
                type="button"
                variant="ghost"
                className="justify-start"
                onClick={() => goTo(item.path)}
              >
                <item.icon className="mr-2 h-4 w-4" />
                {item.title}
              </Button>
            ))}
            <div className="my-2 border-t border-slate-800" />
            <p className="text-xs text-slate-400">账户与外观</p>
            <Button
              type="button"
              variant="ghost"
              className="justify-start"
              onClick={() => {
                setOpen(false);
                setPasswordOpen(true);
              }}
            >
              <LockKeyhole className="mr-2 h-4 w-4" />
              修改密码
            </Button>
            <ThemeToggle />
            <Button
              type="button"
              variant="ghost"
              className="justify-start text-rose-300 hover:text-rose-200"
              onClick={() => onAuthExpired?.()}
            >
              <LogOut className="mr-2 h-4 w-4" />
              退出登录
            </Button>
          </div>
        </SheetContent>
      </Sheet>
      {passwordOpen ? (
        <ChangePasswordDialog onClose={() => setPasswordOpen(false)} />
      ) : null}
    </>
  );
}
