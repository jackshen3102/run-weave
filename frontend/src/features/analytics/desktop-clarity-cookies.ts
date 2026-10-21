const COOKIE_NAMES = ["_clck", "_clsk"] as const;
const STORAGE_PREFIX = "runweave:clarity:cookie:";

// Chromium does not persist document.cookie on custom schemes. Keep the two
// SDK-owned cookies on the desktop origin; every other cookie uses the browser.
export function installDesktopClarityCookies(): void {
  const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, "cookie");
  if (!descriptor?.get || !descriptor.set || Object.hasOwn(document, "cookie")) return;
  const readNative = () => descriptor.get?.call(document) as string;
  const writeNative = (value: string) => descriptor.set?.call(document, value);

  try {
    Object.defineProperty(document, "cookie", {
      configurable: true,
      get() {
        const native = readNative();
        const cookies = native ? [native] : [];
        for (const name of COOKIE_NAMES) {
          if (native.split(";").some((cookie) => cookie.trim().startsWith(`${name}=`))) continue;
          try {
            const stored: unknown = JSON.parse(localStorage.getItem(`${STORAGE_PREFIX}${name}`) ?? "null");
            if (!stored || typeof stored !== "object" || !("value" in stored) || !("expires" in stored)) continue;
            if (typeof stored.expires !== "number" || stored.expires <= Date.now()) {
              localStorage.removeItem(`${STORAGE_PREFIX}${name}`);
            } else if (typeof stored.value === "string" && !/[;\r\n]/u.test(stored.value)) {
              cookies.push(`${name}=${stored.value}`);
            }
          } catch { /* Unavailable storage must not affect the app. */ }
        }
        return cookies.join("; ");
      },
      set(input: unknown) {
        const value = String(input);
        writeNative(value);
        const [pair = "", ...attributes] = value.split(";");
        const equals = pair.indexOf("=");
        if (equals < 0) return;
        const name = pair.slice(0, equals).trim();
        if (!COOKIE_NAMES.some((cookie) => cookie === name)) return;
        const cookieValue = pair.slice(equals + 1);
        const options = new Map(attributes.flatMap((attribute) => {
          const index = attribute.indexOf("=");
          return index < 0 ? [] : [[attribute.slice(0, index).trim().toLowerCase(), attribute.slice(index + 1).trim()] as const];
        }));
        const domain = options.get("domain")?.replace(/^\./u, "");
        if ((domain && domain !== location.hostname) || (options.get("path") ?? "/") !== "/") return;
        const maxAge = options.get("max-age");
        const expires = maxAge !== undefined && /^-?\d+$/u.test(maxAge)
          ? Date.now() + Number(maxAge) * 1_000
          : Date.parse(options.get("expires") ?? "");
        if (!Number.isFinite(expires)) return;
        try {
          const key = `${STORAGE_PREFIX}${name}`;
          if (expires <= Date.now() || readNative().split(";").some((cookie) => cookie.trim() === `${name}=${cookieValue}`)) {
            localStorage.removeItem(key);
          } else {
            localStorage.setItem(key, JSON.stringify({ value: cookieValue, expires }));
          }
        } catch { /* Collection remains optional when storage is unavailable. */ }
      },
    });
  } catch { /* A host policy may prohibit overriding the document accessor. */ }
}
