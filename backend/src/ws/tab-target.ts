import type { BrowserContext, Page } from "playwright";

interface TargetInfoResponse {
  targetInfo?: {
    targetId?: string;
  };
}

export async function resolvePageTargetId(
  context: BrowserContext,
  page: Page,
): Promise<string | null> {
  const cdpSession = await context.newCDPSession(page);
  try {
    const targetInfo =
      ((await cdpSession.send("Target.getTargetInfo")) as TargetInfoResponse)
        .targetInfo ?? null;
    return targetInfo?.targetId ?? null;
  } finally {
    await cdpSession.detach().catch(() => undefined);
  }
}

export async function resolvePageByTargetId(
  context: BrowserContext,
  targetId: string,
): Promise<Page | null> {
  const pages = context.pages();
  for (const page of pages) {
    const pageTargetId = await resolvePageTargetId(context, page);
    if (pageTargetId === targetId) {
      return page;
    }
  }
  return null;
}
