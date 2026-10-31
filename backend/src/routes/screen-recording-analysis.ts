import type { WorkHistoryService } from "../work-history/work-history-service";
import { Router, type Request } from 'express';
import type { AnalysisMethod } from '@runweave/shared/screen-recording';
import type { ScreenRecordingService } from '../screen-recording/service';
import type { AuthService } from '../auth/service';
import { readBearerToken } from '../auth/middleware';
import { ScreenRecordingFailure } from '../screen-recording/client';

export function createScreenRecordingAnalysisRouter(service: ScreenRecordingService, auth: AuthService, history: WorkHistoryService): Router {
  const router = Router();
  router.use((_req,res,next) => { res.setHeader('Cache-Control','no-store'); next(); });
  const text = (value: unknown): string => { if (typeof value !== 'string' || !value || value.length > 256 || /[\\/\0]/.test(value)) throw new ScreenRecordingFailure(400,'INVALID_ARGUMENT'); return value; };
  const integer = (value: unknown): number => { const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value; if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) throw new ScreenRecordingFailure(400,'INVALID_ARGUMENT'); return n; };
  const register = (verb: 'get'|'post', route: string, method: AnalysisMethod | 'analysisConversation', input: (req: Request) => object) => {
    router[verb](route,async (req,res) => {
      const controller = new AbortController(); const abort = () => { if (!res.writableFinished) controller.abort(); }; res.on('close',abort);
      try {
        const token = readBearerToken(req), identity = token ? auth.verifyAccessToken(token) : null;
        if (!identity) throw new ScreenRecordingFailure(401,'UNAUTHORIZED');
        const app = auth.getActiveAppSession(identity.sessionId);
        if (app && app.connectionId !== (req.header('X-Connection-ID') ?? '')) throw new ScreenRecordingFailure(403,'FORBIDDEN');
        const args = input(req);
        const result = method === 'analysisConversation'
          ? { body: JSON.stringify(await history.analysisConversation(text(req.query.provider), text(req.params.id))) }
          : await service.execute(method,{ input: JSON.stringify(args) },{ sessionID: identity.sessionId,connectionID: app?.connectionId ?? '' },controller.signal);
        if (!auth.verifyAccessToken(token!)) throw new ScreenRecordingFailure(401,'UNAUTHORIZED');
        if (!controller.signal.aborted) res.type('application/json').send(result.body);
      } catch (error) {
        const safe = error instanceof ScreenRecordingFailure ? error : new ScreenRecordingFailure(503,'ANALYSIS_UNAVAILABLE');
        if (!controller.signal.aborted && !res.headersSent) res.status(safe.status).json({ code: safe.code,message: safe.code,retryable: safe.retryable });
      } finally { res.off('close',abort); }
    });
  };
  register('get','/conversations/:id','analysisConversation',() => ({}));
  register('get','/search','analysisSearch',req => {
    const { q, from, to, limit } = req.query;
    if (typeof q !== 'string' || !q.trim() || Buffer.byteLength(q, 'utf8') > 48000 ||
        typeof from !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(from) ||
        typeof to !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(to) ||
        (limit !== undefined && (typeof limit !== 'string' || !/^[0-9]+$/.test(limit)))) {
      throw new ScreenRecordingFailure(400,'INVALID_ARGUMENT');
    }
    const count = limit === undefined ? 100 : integer(limit);
    if (count < 1 || count > 100) throw new ScreenRecordingFailure(400,'INVALID_ARGUMENT');
    return { q, from, to, limit: count };
  });
  register('get','/status','analysisStatus',() => ({}));
  register('get','/cards','analysisCards',req => ({ day: text(req.query.day),...(req.query.cursor === undefined ? {} : { cursor: text(req.query.cursor) }),...(req.query.limit === undefined ? {} : { limit: integer(req.query.limit) }) }));
  register('get','/cards/:id','analysisCard',req => ({ cardID: text(req.params.id) }));
  register('get','/export','analysisExport',req => ({ day: text(req.query.day),...(req.query.snapshotRevision === undefined ? {} : { snapshotRevision: integer(req.query.snapshotRevision) }) }));
  register('get','/captures/:id','resolveAnalysisCapture',req => ({ captureID: text(req.params.id) }));
  register('post','/retry','retryAnalysis',req => ({ batchID: text(req.body?.batchID),expectedRevision: integer(req.body?.expectedRevision),operationID: text(req.body?.operationID) }));
  return router;
}
