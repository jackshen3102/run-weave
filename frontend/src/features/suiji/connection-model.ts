import type { SuijiInfo } from "@runweave/shared/suiji";
import type { SuijiClient } from "../../services/suiji";
import type { SuijiDraftStore } from "./drafts";

export type SuijiConnection = {
  client: SuijiClient;
  info: SuijiInfo;
  store: SuijiDraftStore;
};
