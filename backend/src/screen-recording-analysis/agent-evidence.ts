import type { WorkHistoryService } from '../work-history/work-history-service';
import type { AnalysisCollector } from './collector';
import type { ScreenAgentEvent } from '@runweave/shared/screen-recording';

/** Page native events, not terminal screens or lastActivityAt completion guesses. */
export async function collectAgentEvidence(history: WorkHistoryService, collector: AnalysisCollector, deviceID: string, effectiveFrom: number, signal: AbortSignal): Promise<void> {
  const state = await collector.request<{ threadAfter?: string }>('analysisAgentCursor',{ expectedDeviceID: deviceID,threadID: '__threads__' },signal);
  const page = await history.analysisThreadsPage(state.threadAfter);
  // One bounded source page per tick. Cursors live with the owner and survive
  // Backend replacement. Unsupported providers retain unknown coverage.
  for (const thread of page.threads.slice(0,4)) {
    const saved = await collector.request<{ cursor?: string }>('analysisAgentCursor',{ expectedDeviceID: deviceID,threadID: thread.threadId },signal);
    const events = await history.analysisEvidencePage(thread.threadId,saved.cursor,signal);
    const selected: ScreenAgentEvent[] = events.events.filter(event => !event.derived && event.occurredAtMs >= effectiveFrom);
    if (Buffer.byteLength(JSON.stringify(selected)) > 32000) continue; // Never acknowledge an unread/oversized page.
    await collector.request('ingestAnalysisEvents',{ expectedDeviceID: deviceID,threadID: thread.threadId,expectedCursor: saved.cursor ?? '',cursor: events.nextCursor,coverage: events.coverage,events: selected },signal);
  }
  // Move thread selection in stable source order; the final page wraps so
  // already known threads are revisited for their newly appended events.
  const after = page.threads.length > 4 ? page.threads[3]!.lastEventId : page.threads.length === 100 ? page.threads.at(-1)!.lastEventId : '';
  await collector.request('ingestAnalysisEvents',{ expectedDeviceID: deviceID,threadID: '__threads__',expectedCursor: state.threadAfter ?? '',cursor: after,coverage: 'partial',events: [] },signal);
}
