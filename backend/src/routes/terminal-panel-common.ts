import type { Response } from "express";
import { TerminalPanelError } from "../terminal/application/panel-common";

export {
  buildPaneTarget,
  getSessionOrThrow,
  requireTmuxSession,
  TerminalPanelError as TerminalPanelRouteError,
} from "../terminal/application/panel-common";
export type {
  TerminalPanelOptions as TerminalPanelRouteOptions,
  TerminalPanelTargetResolution,
} from "../terminal/application/panel-common";

export function sendTerminalPanelRouteError(
  res: Response,
  error: unknown,
): boolean {
  if (error instanceof TerminalPanelError) {
    res.status(error.statusCode).json({
      message: error.message,
      details: error.details,
    });
    return true;
  }
  return false;
}
