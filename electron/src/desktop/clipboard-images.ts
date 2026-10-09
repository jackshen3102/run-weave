import { ipcMain } from "electron";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { ClipboardImageDownload } from "@runweave/shared/desktop-bridge";

const blocked = new BlockList();
for (const [ip, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const)
  blocked.addSubnet(ip, prefix, "ipv4");
function publicAddress(address: string): boolean {
  if (isIP(address) === 4) return !blocked.check(address, "ipv4");
  // Only global unicast; exclude documentation, transition and special-use ranges.
  return (
    /^[23][0-9a-f]{3}:/i.test(address) &&
    !/^2001:(?:0{0,3}[012]:|db8:)/i.test(address) &&
    !/^2002:/i.test(address)
  );
}
const maxBytes = 20 * 1024 * 1024;

async function download(
  url: URL,
  deadline: number,
  redirects = 0,
): Promise<ClipboardImageDownload> {
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("图片地址不受支持");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  let timer: NodeJS.Timeout | undefined;
  const addresses = await Promise.race([
    lookup(hostname, { all: true }),
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("图片下载超时")),
        Math.max(1, deadline - Date.now()),
      );
    }),
  ]).finally(() => clearTimeout(timer));
  if (
    !addresses.length ||
    addresses.some((entry) => !publicAddress(entry.address))
  )
    throw new Error("图片地址必须是公开网络地址");
  const pinned = addresses[0]!;
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("图片下载超时");
  return new Promise((resolve, reject) => {
    const fail = (message: string) => reject(new Error(message));
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        headers: { Accept: "image/png,image/jpeg,image/webp,image/gif" },
        // Pin the validated DNS answer; no proxy, Cookie, Authorization or renderer session.
        family: pinned.family,
        lookup: (_host, _options, callback) =>
          callback(null, pinned.address, pinned.family),
        signal: AbortSignal.timeout(remaining),
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status)) {
          response.destroy();
          if (redirects >= 4 || !response.headers.location) {
            fail("图片重定向过多");
            return;
          }
          let next: URL;
          try {
            next = new URL(response.headers.location, url);
          } catch {
            fail("图片重定向地址无效");
            return;
          }
          void download(next, deadline, redirects + 1).then(resolve, reject);
          return;
        }
        if (status !== 200) {
          response.destroy();
          fail(`图片下载失败（HTTP ${status}）`);
          return;
        }
        let size = 0;
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            response.destroy();
            fail("图片超过 20 MiB");
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", () => fail("图片下载中断"));
        response.on("end", () => {
          const data = Buffer.concat(chunks);
          const mimeType = data
            .subarray(0, 8)
            .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
            ? "image/png"
            : data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff
              ? "image/jpeg"
              : /^GIF8[79]a$/.test(data.subarray(0, 6).toString())
                ? "image/gif"
                : data.subarray(0, 4).toString() === "RIFF" &&
                    data.subarray(8, 12).toString() === "WEBP"
                  ? "image/webp"
                  : null;
          if (!mimeType) {
            fail("返回内容不是支持的图片");
            return;
          }
          resolve({ mimeType, dataBase64: data.toString("base64") });
        });
      },
    );
    request.on("error", () => fail("图片下载失败或超时"));
    request.end();
  });
}

export function registerClipboardImageHandlers(
  mainWindow: () => Electron.BrowserWindow | null,
): void {
  let active = 0;
  ipcMain.handle("clipboard:download-image", async (event, value: unknown) => {
    const window = mainWindow();
    if (
      !window ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame
    )
      throw new Error("无效图片请求来源");
    if (typeof value !== "string" || value.length > 16_384)
      throw new Error("无效图片地址");
    if (active >= 3) throw new Error("图片下载繁忙，请重试");
    active++;
    try {
      return await download(new URL(value), Date.now() + 15_000);
    } finally {
      active--;
    }
  });
}
