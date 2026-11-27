import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { CreateTerminalContextHandoffRequest } from "@runweave/shared/terminal/context-handoff";
import type {
  TerminalSessionManager,
  TerminalSessionRecord,
} from "../manager/manager";
import type { TerminalTextAttachmentDelivery } from "../attachments/text-attachment-delivery";
import { readCodexContext } from "../runtime/codex-context";
import { getAgentForCommand } from "../state/terminal-state-service";
import type { TerminalSessionCreationOptions } from "./create-session";
import { sendInputToSession } from "./input-dispatcher";
import { buildPaneTarget } from "./panel-common";

export async function deliverHandoff(
  manager: TerminalSessionManager,
  options: TerminalSessionCreationOptions,
  delivery: TerminalTextAttachmentDelivery,
  session: TerminalSessionRecord,
  panelId: string,
  request: CreateTerminalContextHandoffRequest,
  document: string | null,
  generation?: string,
) {
  const panel = manager.getPanel(panelId);
  const pane =
    panel && options.tmuxService
      ? buildPaneTarget(session, options.tmuxService, panel)
      : undefined;
  const agent = request.targetAgent;
  const validate = () => {
    if (
      manager.getSession(session.id)?.status !== "running" ||
      session.projectId !== request.targetProjectId ||
      (panel &&
        (manager.getPanel(panelId)?.status !== "running" ||
          manager.getPanelWorkspace(session.id)?.activePanelId !== panelId ||
          (generation &&
            !manager.matchesPanelAgentOperationGeneration(
              session.id,
              panelId,
              generation,
              agent,
            ))))
    )
      throw new Error("目标终端或启动操作已变化");
  };
  const deadline = Date.now() + 30_000;
  while (true) {
    validate();
    const state = (panel ?? session).terminalState;
    const codex = panel && agent === "codex" ? readCodexContext(panel) : null;
    const live = pane && (await options.tmuxService!.readPaneMetadata(pane));
    const cli = getAgentForCommand(live?.paneCommand ?? null);
    const registered = agent === "pi" && !!panel?.pi;
    if (generation && codex?.managed && codex.context && codex.context.operationId !== generation)
      throw new Error("目标 Codex 启动代次已变化");
    if (
      codex?.managed
        ? codex.context?.inputReady && !codex.context.closed && codex.context.primaryThreadId === codex.context.displayedThreadId
        : registered ||
          (state?.state === "agent_idle" &&
            state.agent === agent &&
            (!pane ||
              cli === agent ||
              getAgentForCommand(live?.activeCommand ?? null) === agent))
    )
      break;
    if (
      !codex?.managed &&
      pane &&
      cli === agent &&
      (agent === "claude" || agent === "codex")
    ) {
      const screen = await options.tmuxService!.capturePaneSnapshot(pane);
      if ((agent === "claude" ? /^\s*❯/mu : /^\s*›/mu).test(screen)) break;
    }
    if (Date.now() >= deadline) throw new Error("等待目标 CLI 输入就绪超时");
    await delay(250);
  }
  validate();
  const threadId = panel
    ? (readCodexContext(panel).context?.displayedThreadId ?? panel.threadId)
    : session.threadId;
  if (document === null) {
    await sendInputToSession(
      manager,
      { ...options, supervisorInput: true, handoffAgent: agent, validateSupervisorTarget: validate },
      session,
      request.prompt,
      "prompt_replace",
      request.operationId,
      pane,
      request.submitPrompt,
    );
    return null;
  }
  const preparation = delivery.prepare(session.id, panelId);
  const file = await delivery.create(session.id, {
    operationId: randomUUID(),
    preparationId: preparation.preparationId,
    purpose: "composer",
    panelId,
    expectedThreadId: threadId,
    text: document,
  });
  validate();
  await delivery.composer(
    session.id,
    {
      operationId: request.operationId,
      panelId,
      textAttachmentIds: [file.id],
      data: request.prompt
        ? `本次附加指令：\n${request.prompt}`
        : "请阅读交接上下文，等待下一步指令。",
      mode: "prompt_replace",
      submit: request.submitPrompt,
    },
    undefined,
    { validateTarget: validate, agent },
  );
  return file.filePath;
}
