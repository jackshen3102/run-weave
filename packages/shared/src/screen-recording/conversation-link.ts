/** Public navigation intent only; contains no credentials or filesystem paths. */
export interface ScreenConversationLink { deviceID: string; provider: 'codex'; threadID: string }
export function parseScreenConversationLink(raw: string): ScreenConversationLink | null {
  if (raw.length > 1024) return null;
  try {
    const url = new URL(raw);
    if (!['runweave:', 'runweave-beta:'].includes(url.protocol) || url.hostname !== 'screen-conversation' ||
        url.pathname !== '' || url.username || url.password || url.port || url.hash ||
        [...url.searchParams.keys()].some(key => !['deviceID','provider','threadID'].includes(key))) return null;
    for (const key of ['deviceID','provider','threadID']) if (url.searchParams.getAll(key).length !== 1) return null;
    const deviceID = url.searchParams.get('deviceID')!, threadID = url.searchParams.get('threadID')!;
    if (url.searchParams.get('provider') !== 'codex' || ![deviceID,threadID].every(value => /^[A-Za-z0-9_-]{1,200}$/.test(value))) return null;
    return { deviceID, provider: 'codex', threadID };
  } catch { return null; }
}
