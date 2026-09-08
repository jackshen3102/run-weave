import { createContext, useContext } from "react";

export const MobileLoginContext = createContext<(() => void) | null>(null);
export const useOpenMobileLogin = () => useContext(MobileLoginContext);
