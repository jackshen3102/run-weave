import type { AnalysisManifest, ScreenRecordingCapture } from '@runweave/shared/screen-recording';

/** Omit known stable repeats; prefer transitions within the budget and preserve endpoints. */
export function representativeFrames(manifest: AnalysisManifest, maximum = 15): ScreenRecordingCapture[] {
  const frames = manifest.captures.filter(frame => !frame.privacyPlaceholder);
  if (!Number.isSafeInteger(maximum) || maximum < 1) return [];
  if (maximum === 1) return frames.slice(0,1);
  const priorities = frames.map((frame,index) => {
    const previous = frames[index-1];
    const app = frame.frontmostApplication?.id, previousApp = previous?.frontmostApplication?.id;
    if (previous && (frame.sessionID !== previous.sessionID || frame.displayID !== previous.displayID ||
        (app && previousApp && app !== previousApp))) return 3;
    if (frame.visualChanged === true && previous?.visualChanged === false) return 2;
    // Legacy/unknown signals remain eligible alongside changing frames.
    return frame.visualChanged === false ? 0 : 1;
  });
  // Keep boundaries and unknown signals, but never fill the budget with known
  // stable interior frames. Compute priorities before pruning to retain onsets.
  const candidates = frames.map((_,index) => index).filter(index =>
    index === 0 || index === frames.length-1 || priorities[index]! > 0);
  if (candidates.length <= maximum) return candidates.map(index => frames[index]!);
  const indices = new Set<number>();
  const interior = candidates.slice(1,-1);
  if (interior.every(index => priorities[index] === priorities[interior[0]!])) {
    // With no distinguishing signals, retain the original uniform selection.
    for (let i = 0; i < maximum; i++) indices.add(candidates[Math.round(i * (candidates.length - 1) / (maximum - 1))]!);
  } else {
    indices.add(0); indices.add(frames.length-1);
    while (indices.size < maximum) {
      let best = -1, bestPriority = -1, bestDistance = -1;
      for (const index of interior) {
        if (indices.has(index)) continue;
        const priority = priorities[index]!;
        const distance = Math.min(...[...indices].map(selected => Math.abs(index-selected)));
        // Spread equal-priority candidates across the original input positions.
        if (priority > bestPriority || (priority === bestPriority && distance > bestDistance)) {
          best = index; bestPriority = priority; bestDistance = distance;
        }
      }
      indices.add(best);
    }
  }
  return [...indices].sort((a,b) => a-b).map(index => frames[index]!);
}
export function idleObservation(manifest: AnalysisManifest): string | undefined {
  if (!manifest.captures.length && !manifest.evidence.length) return '当前没有可分析的已记录材料；不代表没有工作。';
  if (manifest.evidence.some(item => item.source === 'agent' && item.occurredAtMs >= manifest.startMs)) return undefined;
  if (manifest.captures.every(frame => frame.privacyPlaceholder)) return '已记录范围均为隐私占位，未分析画面；后台来源覆盖未知。';
  // Input idleness alone also includes reading, videos and running Agents.
  // Older captures have no visual signal and must take the normal analysis path.
  // Empty means handled without adding another timeline observation.
  if (manifest.captures.length && manifest.captures.every(frame => frame.visualChanged === false &&
      !frame.context?.accessibility?.texts.length && !frame.context?.accessibility?.removed.length)) return '';
  return undefined;
}
