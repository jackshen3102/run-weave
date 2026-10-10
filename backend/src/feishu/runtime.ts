import { configuration, settingText } from "@runweave/config-node";
import {
  FeishuBridgeError,
  isFeishuNotifyPayload,
  type FeishuNotifyPayload,
} from "@runweave/shared/feishu/bridge";
import { FeishuBridgeConnector } from "./bridge-connector";
import type { TerminalSessionManager } from "../terminal/manager/manager";
import {
  submitTerminalInput,
  type TerminalSubmissionOptions,
} from "../terminal/application/submit-input";
import type { ConnectionIdentityService } from "../auth/connection-identity";
import type { RuntimeStatusRegistry } from "../runtime-status/registry";
import { feishuReportSchema } from "../runtime-status/feishu-report";
import { isMissingTerminalRuntimeError } from "../terminal/application/input-dispatcher";
import { logger } from "../logging/index";
export function createFeishuNode(
  identity: ConnectionIdentityService,
  sessions: TerminalSessionManager,
  inputOptions: TerminalSubmissionOptions,
  registry: RuntimeStatusRegistry,
): FeishuBridgeConnector | undefined {
  if (settingText("services.feishu.role") !== "node") return undefined;
  try {
    configuration().requireDomain("services.feishu");
    const backendId = identity.identity()?.identityId;
    if (!backendId) throw new Error("identity_unavailable");
    const connector = new FeishuBridgeConnector({
      url: settingText("services.feishu.node.url")!,
      token: settingText("services.feishu.node.token")!,
      caCertificate: settingText("services.feishu.node.caCertificate") ?? undefined,
      backendId,
      getTerminal: async (id) => {
        const session = sessions.getSession(id);
        if (!session) throw new FeishuBridgeError("not_found");
        return { status: session.status === "running" ? "running" : "exited" };
      },
      input: async (input) => {
        const session = sessions.getSession(input.terminalSessionId);
        if (!session) throw new FeishuBridgeError("not_found");
        if (session.status !== "running")
          throw new FeishuBridgeError("not_running");
        try {
          const result = await submitTerminalInput(
            sessions,
            inputOptions,
            session,
            {
              operationId: `feishu:${input.messageId}`,
              data: input.text,
              mode: "prompt_replace",
              submit: true,
            },
            () => {
              if (Date.now() >= input.expiresAt)
                throw new FeishuBridgeError("expired");
            },
          );
          return {
            inputAccepted: result.inputAccepted === true,
            inputEnqueued: result.inputEnqueued === true,
          };
        } catch (error) {
          if (isMissingTerminalRuntimeError(error)) {
            sessions.markExited(session.id, session.exitCode);
            throw new FeishuBridgeError("not_running");
          }
          throw error;
        }
      },
      report: (report) => {
        registry.setExternalReport(feishuReportSchema.parse(report));
      },
    });
    configuration().markApplied("services.feishu");
    return connector;
  } catch {
    configuration().reportError("services.feishu");
    logger.warn("feishu.node.unavailable", {
      message: "Feishu node configuration or identity unavailable",
    });
    return undefined;
  }
}
export async function forwardFeishuNotification(
  connector: FeishuBridgeConnector | undefined,
  sessions: TerminalSessionManager,
  payload: unknown,
) {
  if (!isFeishuNotifyPayload(payload))
    throw new FeishuBridgeError("invalid_request");
  if (!sessions.getSession(payload.terminalSessionId))
    throw new FeishuBridgeError("not_found");
  if (!connector) throw new FeishuBridgeError("unavailable");
  return connector.notify(payload as FeishuNotifyPayload);
}
