const TERMINAL_BROWSER_COOKIE_RETENTION_SECONDS = 10 * 365 * 24 * 60 * 60;

let terminalBrowserCookiePersistenceRegistered = false;

function getTerminalBrowserCookieExpirationDate(): number {
  return Math.floor(Date.now() / 1000) + TERMINAL_BROWSER_COOKIE_RETENTION_SECONDS;
}

function buildTerminalBrowserCookieUrl(cookie: Electron.Cookie): string | null {
  const domain = cookie.domain?.replace(/^\./, "");
  if (!domain) {
    return null;
  }
  const protocol = cookie.secure ? "https" : "http";
  const pathName = cookie.path?.startsWith("/") ? cookie.path : "/";
  try {
    return new URL(pathName, `${protocol}://${domain}`).toString();
  } catch {
    return null;
  }
}

export function ensureTerminalBrowserCookiePersistence(
  browserSession: Electron.Session,
): void {
  if (terminalBrowserCookiePersistenceRegistered) {
    return;
  }

  browserSession.cookies.on("changed", (_event, cookie, _cause, removed) => {
    if (removed || cookie.session !== true) {
      return;
    }

    const url = buildTerminalBrowserCookieUrl(cookie);
    if (!url) {
      return;
    }

    void browserSession.cookies
      .set({
        url,
        name: cookie.name,
        value: cookie.value,
        ...(cookie.hostOnly ? {} : { domain: cookie.domain }),
        path: cookie.path,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        sameSite: cookie.sameSite,
        expirationDate: getTerminalBrowserCookieExpirationDate(),
      })
      .then(() => browserSession.cookies.flushStore())
      .catch((error) => {
        console.warn("[electron] failed to persist terminal browser session cookie", {
          domain: cookie.domain,
          name: cookie.name,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  });
  terminalBrowserCookiePersistenceRegistered = true;
}
