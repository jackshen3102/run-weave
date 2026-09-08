import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../../components/ui/dialog";
import type { useMobileLogin } from "./use-mobile-login";

function QrCanvas({ payload }: { payload: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void import("qrcode").then(async (qr) => {
      if (!cancelled && canvas.current) await qr.toCanvas(canvas.current, payload, {
        width: 320, margin: 4, errorCorrectionLevel: "L", color: { dark: "#000000", light: "#ffffff" },
      });
    }).catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [payload]);
  return failed ? <p role="alert">地址过长，无法显示二维码。请使用较短的连接地址或手动登录。</p> :
    <canvas ref={canvas} width={320} height={320} className="mx-auto min-h-[320px] min-w-[320px] bg-white" aria-label="用 Runweave iOS 扫描登录二维码" />;
}

const labels = {
  waiting_scan: "请在 iOS App 的连接管理中点击「扫码连接电脑」",
  pending_approval: "等待你确认这台手机",
  approved: "正在完成手机登录", issuing: "正在完成手机登录", issued: "正在完成手机登录",
  completed: "手机已登录", cancelled: "已取消", rejected: "已拒绝手机登录",
  expired: "二维码已过期，请重新生成", unconfirmed: "未收到手机完成确认；已保存的手机登录仍可使用",
  failed: "登录凭据签发失败，请重新扫码",
};

export function MobileLoginDialog({ controller: c, connectionName }: {
  controller: ReturnType<typeof useMobileLogin>; connectionName: string;
}) {
  const locked = c.status && ["approved", "issuing", "issued"].includes(c.status.state);
  return <Dialog open={c.opened} onOpenChange={(open) => { if (!open) c.close(); }}>
    <DialogContent className="sm:max-w-[460px]">
      <DialogHeader><DialogTitle>连接手机 · {connectionName}</DialogTitle>
        <DialogDescription>手机需能访问此电脑。扫码后，由你在这里确认登录。</DialogDescription>
      </DialogHeader>
      {c.addresses.length > 0 ? <label className="grid gap-2 text-sm">连接地址
        <select className="w-full rounded-md border bg-background p-2" value={c.address} disabled={c.busy || !!locked}
          onChange={(event) => c.generate(event.target.value)}>
          {c.addresses.map((address) => <option key={address} value={address}>{address}</option>)}
        </select>
      </label> : null}
      <div className="grid min-h-[160px] content-center gap-4 py-2 text-center" aria-live="polite">
        {c.qr && c.status?.state === "waiting_scan" && c.seconds > 0 && !c.error ? <>
          <QrCanvas key={c.qr.requestId} payload={JSON.stringify(c.qr)} />
          <p className="text-sm text-muted-foreground">剩余 {c.seconds} 秒</p>
        </> : null}
        {c.status ? <p>{labels[c.status.state]}</p> : c.busy ? <p>正在准备连接…</p> : null}
        {c.status?.state === "pending_approval" ? <>
          <p className="font-medium">{c.status.deviceName} 请求登录</p>
          <div className="flex justify-center gap-3">
            <Button disabled={c.busy || !!c.error} onClick={() => void c.decide("approve")}>允许登录</Button>
            <Button variant="outline" disabled={c.busy || !!c.error} onClick={() => void c.decide("reject")}>拒绝</Button>
          </div>
        </> : null}
        {c.error ? <p role="alert" className="text-sm text-destructive">{c.error}</p> : null}
      </div>
      {!locked && c.status?.state !== "completed" ? <Button variant="outline" disabled={c.busy}
        onClick={() => c.address ? c.generate(c.address) : void c.open()}>重新生成二维码</Button> : null}
      <p className="text-xs text-muted-foreground">也可以在手机连接管理中手动填写地址，使用原有账号密码登录。</p>
    </DialogContent>
  </Dialog>;
}
