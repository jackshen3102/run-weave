export interface TerminalBrowserCdpProxyInfo {
  available: boolean;
  endpoint: string | null;
  port: number | null;
  host: "127.0.0.1";
  tabId: string;
  targetId: string | null;
  url: string;
  title: string;
  attached: boolean;
  devtoolsOpen: boolean;
  env: { PLAYWRIGHT_MCP_CDP_ENDPOINT: string } | null;
  error?: string;
}
