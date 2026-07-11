import type {
  CreateTerminalPrototypePreviewTicketResponse,
  TerminalPrototypeGalleryResponse,
  TerminalPrototypeGallerySource,
} from "@runweave/shared/terminal/preview";
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
  prototypeSource: TerminalPrototypeGallerySource,
  prototypeSlug: string,
): Promise<CreateTerminalPrototypePreviewTicketResponse> {
  return requestJson<CreateTerminalPrototypePreviewTicketResponse>(
    apiBase,
    `/api/terminal/project/${encodeURIComponent(projectId)}/prototype/${encodeURIComponent(prototypeSource)}/${encodeURIComponent(prototypeSlug)}/preview-ticket`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  );
}
