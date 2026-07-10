import type {
  CreateTerminalPrototypePreviewTicketResponse,
  TerminalPrototypeGalleryResponse,
} from "@runweave/shared";
import { requestJson } from "./http";

export async function listTerminalPrototypeGallery(
  apiBase: string,
  token: string,
): Promise<TerminalPrototypeGalleryResponse> {
  return requestJson<TerminalPrototypeGalleryResponse>(
    apiBase,
    "/api/terminal/prototype-gallery",
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  );
}

export async function createTerminalPrototypePreviewTicket(
  apiBase: string,
  token: string,
  projectId: string,
  prototypeSlug: string,
): Promise<CreateTerminalPrototypePreviewTicketResponse> {
  return requestJson<CreateTerminalPrototypePreviewTicketResponse>(
    apiBase,
    `/api/terminal/project/${encodeURIComponent(projectId)}/prototype/${encodeURIComponent(prototypeSlug)}/preview-ticket`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  );
}
