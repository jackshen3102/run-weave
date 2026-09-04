import { Capacitor } from "@capacitor/core";
import { LocalNotifications } from "@capacitor/local-notifications";

/**
 * 本地通知服务。
 *
 * 说明：这里只用「本地通知」，不涉及 APNs 远程推送。
 * 本地通知不需要 aps-environment entitlement，因此免费 Apple 开发者账号
 * 签名的构建也能正常使用；远程推送则必须付费账号。
 *
 * 能力边界：app 在前台或后台存活期间可以弹出通知；一旦被系统回收进程，
 * 就无法再触发，这种场景只有远程推送能覆盖。
 */

/** iOS 通知 id 必须是 32 位有符号整数 */
const MAX_NOTIFICATION_ID = 2_147_483_647;

let idCounter = 0;

function nextNotificationId(): number {
  idCounter = (idCounter + 1) % 1_000;
  return (Date.now() % (MAX_NOTIFICATION_ID - 1_000)) + idCounter;
}

function isSupported(): boolean {
  return Capacitor.isNativePlatform();
}

export interface NotifyOptions {
  title: string;
  body: string;
  /** 延迟多少毫秒后弹出；省略或 <=0 表示尽快弹出 */
  delayMs?: number;
  /** 附带数据，用户点击通知时可在监听回调里取到 */
  extra?: Record<string, unknown>;
}

/**
 * 确保已获得通知权限。
 *
 * 首次调用会弹出系统授权弹窗；用户拒绝后不再重复弹窗，此时返回 false。
 */
export async function ensureNotificationPermission(): Promise<boolean> {
  if (!isSupported()) {
    return false;
  }

  try {
    const current = await LocalNotifications.checkPermissions();
    if (current.display === "granted") {
      return true;
    }
    if (current.display === "denied") {
      // 用户已明确拒绝，再次 request 不会弹窗，需要去系统设置里开启
      return false;
    }

    const requested = await LocalNotifications.requestPermissions();
    return requested.display === "granted";
  } catch (error) {
    console.warn("[notifications] permission check failed", error);
    return false;
  }
}

/**
 * 发送一条本地通知。
 *
 * 返回是否成功排入队列。权限未授予、非原生环境或调用失败时返回 false，
 * 不会抛错，方便在业务代码里直接调用而无需额外 try/catch。
 */
export async function notify(options: NotifyOptions): Promise<boolean> {
  if (!isSupported()) {
    return false;
  }

  const granted = await ensureNotificationPermission();
  if (!granted) {
    return false;
  }

  const { title, body, delayMs, extra } = options;

  try {
    await LocalNotifications.schedule({
      notifications: [
        {
          id: nextNotificationId(),
          title,
          body,
          ...(delayMs && delayMs > 0
            ? { schedule: { at: new Date(Date.now() + delayMs) } }
            : {}),
          ...(extra ? { extra } : {}),
        },
      ],
    });
    return true;
  } catch (error) {
    console.warn("[notifications] schedule failed", error);
    return false;
  }
}

/**
 * 注册通知点击回调。返回取消注册的函数。
 */
export async function onNotificationTap(
  handler: (extra: Record<string, unknown> | undefined) => void,
): Promise<() => void> {
  if (!isSupported()) {
    return () => {};
  }

  try {
    const listener = await LocalNotifications.addListener(
      "localNotificationActionPerformed",
      (action) => {
        handler(
          action.notification.extra as Record<string, unknown> | undefined,
        );
      },
    );
    return () => {
      void listener.remove();
    };
  } catch (error) {
    console.warn("[notifications] listener registration failed", error);
    return () => {};
  }
}

/** 清除所有已送达的通知 */
export async function clearDeliveredNotifications(): Promise<void> {
  if (!isSupported()) {
    return;
  }
  try {
    const delivered = await LocalNotifications.getDeliveredNotifications();
    if (delivered.notifications.length > 0) {
      await LocalNotifications.removeDeliveredNotifications(delivered);
    }
  } catch (error) {
    console.warn("[notifications] clear failed", error);
  }
}
