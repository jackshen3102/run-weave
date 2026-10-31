import type { AnalysisManifest, ScreenRecordingCapture } from '@runweave/shared/screen-recording';

/** Deterministic representative frames; original order and first/last survive. */
export function representativeFrames(manifest: AnalysisManifest, maximum = 15): ScreenRecordingCapture[] {
  const frames = manifest.captures.filter(frame => !frame.privacyPlaceholder);
  if (frames.length <= maximum) return frames;
  const indices = new Set<number>();
  for (let i = 0; i < maximum; i++) indices.add(Math.round(i * (frames.length - 1) / (maximum - 1)));
  return [...indices].sort((a,b) => a-b).map(index => frames[index]!);
}
export function idleObservation(manifest: AnalysisManifest): string | undefined {
  if (!manifest.captures.length && !manifest.evidence.length) return '当前没有可分析的已记录材料；不代表没有工作。';
  if (manifest.evidence.some(item => item.source === 'agent' && item.occurredAtMs >= manifest.startMs)) return undefined;
  if (manifest.captures.every(frame => frame.privacyPlaceholder)) return '已记录范围均为隐私占位，未分析画面；后台来源覆盖未知。';
  if (manifest.captures.every(frame => typeof frame.idleSeconds === 'number' && frame.idleSeconds >= 120)) return '该段无输入记录；可能在阅读，不能据此判断没有工作。后台来源覆盖未知。';
  return undefined;
}
