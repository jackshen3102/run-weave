import { cleanAbandonedJobs, markJobOwner } from './temporary';
import type { WorkHistoryService } from '../work-history/work-history-service';
import { collectAgentEvidence } from './agent-evidence';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { configurationPath, settingText } from '@runweave/config-node';
import type { AnalysisClaim, AnalysisReceipt, AnalysisResult } from '@runweave/shared/screen-recording';
import { AnalysisCollector } from './collector';
import { AnalysisProvider } from './provider';
import { representativeFrames, idleObservation } from './batching';
import { logger } from '../logging';

export class ScreenRecordingAnalysisRuntime {
  private readonly workerID = randomUUID();
  private readonly collector = new AnalysisCollector();
  private timer?: ReturnType<typeof setTimeout>;
  private active?: Promise<void>;
  private controller?: AbortController;
  private closed = false;
  constructor(private readonly history: WorkHistoryService) {}
  start(): void { if (process.platform === 'darwin') this.schedule(0); }
  private schedule(delay: number): void {
    if (this.closed) return;
    this.timer = setTimeout(() => {
      this.active = this.tick().catch(() => { logger.warn('screen-analysis.tick.failed', { code: 'ANALYSIS_UNAVAILABLE' }); }).finally(() => { this.active = undefined; this.schedule(60000); });
    },delay); this.timer.unref();
  }
  private async tick(): Promise<void> {
    await cleanAbandonedJobs(configurationPath("storage.screenAnalysisDirectory","screen-analysis"));
    if (settingText('screenRecording.analysis.enabled') !== 'true' || this.closed) return;
    const deviceID = settingText('screenRecording.analysis.deviceID')?.trim();
    const effectiveFrom = Date.parse(settingText('screenRecording.analysis.effectiveFrom') ?? '');
    const model = settingText('screenRecording.analysis.model')?.trim();
    const effort = settingText('screenRecording.analysis.effort')?.trim();
    if (!deviceID || !Number.isFinite(effectiveFrom) || effectiveFrom > Date.now() || !model || !effort || !['low','medium','high','xhigh','max','ultra'].includes(effort)) return;
    const provider = new AnalysisProvider({ binary: settingText('agents.codex.binary')?.trim() || 'codex',model,effort });
    const started = Date.now();
    this.controller = new AbortController();
    const signal = this.controller.signal;
    try {
      await collectAgentEvidence(this.history,this.collector,deviceID,effectiveFrom,signal).catch(() => { logger.warn("screen-analysis.agent-source.unavailable",{}); });
      for (let count = 0; count < 4 && Date.now()-started < 600000 && !signal.aborted; count++) {
        const claim = await this.collector.request<AnalysisClaim | null>('claimAnalysis',{ workerID: this.workerID,expectedDeviceID: deviceID,effectiveFrom },signal);
        if (!claim) break;
        await this.execute(claim,provider,signal);
      }
    } finally { this.controller = undefined; }
  }
  private async execute(claim: AnalysisClaim, provider: AnalysisProvider, parent: AbortSignal): Promise<void> {
    const identity = { batchID: claim.manifest.batchID,workerID: this.workerID,generation: claim.generation };
    const controller = new AbortController(); const abort = () => controller.abort(); parent.addEventListener('abort',abort,{ once: true });
    if (parent.aborted) abort();
    const signal = controller.signal;
    let renewing = false;
    const renew = setInterval(() => {
      if (renewing || signal.aborted) return; renewing = true;
      void this.collector.request('renewAnalysis',identity,signal).catch(abort).finally(() => { renewing = false; });
    },30000);
    const expiry = Math.min(...claim.manifest.captures.map(frame => frame.availableUntilMs));
    const expiryTimer = setTimeout(abort,Math.max(0,Math.min(120000,expiry-Date.now())));
    let directory: string | undefined;
    const started = Date.now(); let imageBytes = 0; let frameCount = 0;
    try {
      const idle = idleObservation(claim.manifest);
      let result: AnalysisResult;
      if (idle) result = { cards: [],observation: idle };
      else {
        const root = configurationPath('storage.screenAnalysisDirectory','screen-analysis');
        await mkdir(root,{ recursive: true,mode: 0o700 });
        directory = await mkdtemp(path.join(root,`job-${this.workerID}-`));
        await markJobOwner(directory,process.pid);
        const images: string[] = [];
        for (const frame of representativeFrames(claim.manifest)) {
          if (signal.aborted || frame.availableUntilMs <= Date.now()) throw new Error('SOURCE_EXPIRED');
          const bytes = await this.collector.image(claim,frame.id,signal); imageBytes += bytes.length;
          if (imageBytes > 128*1024*1024) throw new Error("IMAGE_BUDGET");
          const file = path.join(directory,`${images.length}.jpg`); await writeFile(file,bytes,{ mode: 0o600 }); images.push(file);
        }
        frameCount = images.length;
        result = await provider.run(claim.manifest,images,directory,signal);
      }
      if (signal.aborted) throw new Error('CANCELLED');
      const operationID = `${identity.batchID}:${identity.generation}`;
      const input = { ...identity,operationID,inputHash: claim.manifest.inputHash,result };
      try { await this.collector.request<AnalysisReceipt>('commitAnalysis',input,signal); }
      catch (error) {
        // Resolve an unknown commit outcome with the same operation identity.
        const receipt = await this.collector.request<AnalysisReceipt | null>('analysisReceipt',{ operationID },signal);
        if (!receipt) throw error;
      }
      logger.info('screen-analysis.batch.completed',{ frames: frameCount,imageBytes,textBytes: Buffer.byteLength(JSON.stringify(claim.manifest.evidence)),usage: idle ? null : provider.usage ?? null,elapsedMs: Date.now()-started,attempt: claim.attempt });
    } catch (error) {
      const code = error instanceof Error && /^[A-Z_]{1,80}$/.test(error.message) ? error.message : 'ANALYSIS_FAILED';
      await this.collector.request('failAnalysis',{ ...identity,code }).catch(() => {});
      logger.warn('screen-analysis.batch.failed',{ code,attempt: claim.attempt });
    } finally {
      clearInterval(renew); clearTimeout(expiryTimer); parent.removeEventListener('abort',abort);
      // Provider.run resolves/rejects only after its child has exited.
      if (directory) await rm(directory,{ recursive: true,force: true });
    }
  }
  async dispose(): Promise<void> {
    this.closed = true; clearTimeout(this.timer); this.controller?.abort();
    await this.active; this.collector.dispose();
  }
}
