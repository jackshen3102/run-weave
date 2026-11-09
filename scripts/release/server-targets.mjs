// Supported npm Server targets. Intel macOS is no longer released.
export const serverTargets = [
  { runner: "macos-15", target: "darwin-arm64" },
  { runner: "ubuntu-24.04", target: "linux-x64" },
  { runner: "ubuntu-24.04-arm", target: "linux-arm64" },
  { runner: "windows-2022", target: "win32-x64" },
];
