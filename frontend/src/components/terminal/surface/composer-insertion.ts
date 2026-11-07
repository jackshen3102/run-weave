interface ComposerInsertionRequest {
  id: number;
  text: string;
  target?: { destination: "composer"; panelId: string | null };
}

export function consumeComposerInsertion(
  request: ComposerInsertionRequest,
  activePanelId: string | null,
  insertDraft: (text: string) => void,
  consume: (id: number) => void,
): boolean {
  if (request.target?.destination !== "composer") return false;
  if (request.target.panelId === activePanelId) {
    insertDraft(request.text);
  }
  consume(request.id);
  return true;
}
