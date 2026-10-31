import type { AnalysisClaim, AnalysisMethod } from '@runweave/shared/screen-recording';
import { ScreenRecordingClient } from '../screen-recording/client';

export class AnalysisCollector {
  readonly client = new ScreenRecordingClient();
  async request<T>(method: AnalysisMethod, input: object, signal?: AbortSignal): Promise<T> {
    const result = await this.client.request(method, { input: JSON.stringify(input) }, signal);
    return JSON.parse(result.body.toString('utf8')) as T;
  }
  async image(claim: AnalysisClaim, captureID: string, signal: AbortSignal): Promise<Buffer> {
    const result = await this.client.request('analysisFrame', { input: JSON.stringify({ batchID: claim.manifest.batchID,workerID: claim.workerID,generation: claim.generation,captureID }) }, signal);
    if (result.header.contentType !== 'image/jpeg') throw new Error('INVALID_PROTOCOL');
    return result.body;
  }
  dispose(): void { this.client.dispose(); }
}
