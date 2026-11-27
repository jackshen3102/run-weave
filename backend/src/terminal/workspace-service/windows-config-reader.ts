import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);

// libuv defines UV_FS_O_NOFOLLOW as zero on Windows. Inspect and read the same
// OPEN_REPARSE_POINT handle. Denying write/delete sharing pins its contents.
const reader = `
using System;
using System.IO;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class WorktreeConfigReader {
    [StructLayout(LayoutKind.Sequential)]
    private struct AttributeTag { public uint Attributes; public uint ReparseTag; }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(string path, uint access, FileShare share,
        IntPtr security, FileMode mode, uint flags, IntPtr template);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandleEx(SafeFileHandle file, int infoClass,
        out AttributeTag info, uint size);

    public static string Read(string path, int limit) {
        const uint GenericRead = 0x80000000, OpenReparsePoint = 0x00200000;
        const int FileAttributeTagInfo = 9;
        using (var file = CreateFileW(path, GenericRead, FileShare.Read, IntPtr.Zero,
                                      FileMode.Open, OpenReparsePoint, IntPtr.Zero)) {
            if (file.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
            AttributeTag info;
            if (!GetFileInformationByHandleEx(file, FileAttributeTagInfo, out info, 8))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            if (((FileAttributes)info.Attributes & (FileAttributes.ReparsePoint | FileAttributes.Directory)) != 0)
                throw new IOException("Expected a regular file");
            using (var stream = new FileStream(file, FileAccess.Read))
            using (var input = new BinaryReader(stream)) {
                if (stream.Length > limit) throw new IOException("Configuration exceeds size limit");
                var bytes = input.ReadBytes(limit + 1);
                if (bytes.Length > limit || bytes.Length != stream.Length)
                    throw new IOException("Configuration size changed");
                return Convert.ToBase64String(bytes);
            }
        }
    }
}
`;

export async function readWindowsWorktreeConfig(
  file: string,
  limit: number,
): Promise<Buffer> {
  const encodedPath = Buffer.from(file, "utf8").toString("base64");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -TypeDefinition @'",
    reader,
    "'@",
    `$file = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'))`,
    `[WorktreeConfigReader]::Read($file, ${limit})`,
  ].join("\n");
  const { stdout } = await execute(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    { windowsHide: true, timeout: 10_000, maxBuffer: limit * 2 },
  );
  return Buffer.from(stdout.trim(), "base64");
}
