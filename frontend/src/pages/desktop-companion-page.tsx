import { DesktopCompanion } from "../components/desktop-companion/desktop-companion";

export function DesktopCompanionPage(props: {
  apiBase: string;
  token: string | null;
  connectionId: string | null;
}) {
  return <DesktopCompanion {...props} />;
}
