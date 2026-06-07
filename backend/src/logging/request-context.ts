import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";

export interface RequestLogContext {
  requestId: string;
  method: string;
  path: string;
}

const requestContextStorage = new AsyncLocalStorage<RequestLogContext>();

export function getRequestLogContext(): RequestLogContext | undefined {
  return requestContextStorage.getStore();
}

export function createRequestContextMiddleware(): RequestHandler {
  return (req, _res, next) => {
    requestContextStorage.run(
      {
        requestId: randomUUID(),
        method: req.method,
        path: req.path,
      },
      next,
    );
  };
}
