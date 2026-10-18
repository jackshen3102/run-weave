import type { CreateSideChatRequest, CreateSideChatResponse, SideChatCapabilities, SideChatMessagePage, SideChatOperation, SideChatSnapshot, SideChatWriteRequest, SideChatWriteResponse, SendSideChatRequest } from "@runweave/shared/side-chat";
import { HttpError, requestJson } from "./http";
export class SideChatApi {
  constructor(private base: string, private token: string) {}
  private request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    return requestJson<T>(this.base, `/api/side-chats${path}`, { method: body === undefined ? "GET" : "POST", signal: signal ?? AbortSignal.timeout(25_000), cache: "no-store",
      headers: { Authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  capabilities(terminalId: string, panelId?: string | null) { const q = new URLSearchParams({ terminalSessionId: terminalId }); if (panelId) q.set("panelId", panelId); return this.request<SideChatCapabilities>(`/capabilities?${q}`); }
  create(body: CreateSideChatRequest) { return this.request<CreateSideChatResponse>("", body); }
  snapshot(id: string, signal?: AbortSignal) { return this.request<SideChatSnapshot>(`/${encodeURIComponent(id)}`, undefined, signal); }
  messages(id: string, before: number) { return this.request<SideChatMessagePage>(`/${encodeURIComponent(id)}/messages?beforeSequence=${before}&limit=50`); }
  operation(id: string, operationId: string) { return this.request<SideChatOperation>(`/${encodeURIComponent(id)}/operations/${encodeURIComponent(operationId)}`); }
  send(id: string, body: SendSideChatRequest) { return this.request<SideChatWriteResponse>(`/${encodeURIComponent(id)}/turns`, body); }
  async stop(id: string, turnId: string, body: SideChatWriteRequest): Promise<SideChatWriteResponse> {
    const path = `/${encodeURIComponent(id)}/turns/${encodeURIComponent(turnId)}/stop`;
    try { return await this.request<SideChatWriteResponse>(path, body); }
    catch (error) {
      if (!(error instanceof HttpError) || error.status !== 409 || error.code !== "VERSION_CONFLICT") throw error;
      const latest = await this.snapshot(id);
      // Accepted -> running can advance the version before the first poll. Only retry the
      // same still-running turn after a definite rejection; never retarget a later answer.
      if (latest.sideChat.status !== "active" || latest.currentTurn?.id !== turnId ||
        !["accepted", "running"].includes(latest.currentTurn.state)) throw error;
      return this.request<SideChatWriteResponse>(path, { ...body, expectedVersion: latest.sideChat.version });
    }
  }
  end(id: string, body: SideChatWriteRequest) { return this.request<SideChatWriteResponse>(`/${encodeURIComponent(id)}/end`, body); }
}
