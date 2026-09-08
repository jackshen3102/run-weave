import type { ReactNode } from "react";
import type { ConnectionConfig } from "../connection/types";
import { MobileLoginContext } from "./context";
import { MobileLoginDialog } from "./mobile-login-dialog";
import { useMobileLogin } from "./use-mobile-login";

export function MobileLoginProvider({ children, connection, token }: {
  children: ReactNode; connection: ConnectionConfig; token: string;
}) {
  const controller = useMobileLogin(connection, token);
  return <MobileLoginContext.Provider value={controller.open}>
    {children}
    <MobileLoginDialog controller={controller} connectionName={controller.connectionName} />
  </MobileLoginContext.Provider>;
}
