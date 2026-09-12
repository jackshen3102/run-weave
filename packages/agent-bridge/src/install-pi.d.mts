export const bridgeAssets: string[];
export function installPi(options: {
  agentDir: string;
  assetsDir: string;
}): Promise<{
  status: "absent" | "unmanaged" | "installed" | "unchanged";
}>;
