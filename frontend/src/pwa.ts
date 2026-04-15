import { registerSW } from "virtual:pwa-register";
import { registerRunweavePwaAfterDomReady } from "./features/pwa/registration";

registerRunweavePwaAfterDomReady({ registerSW });
