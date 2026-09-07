export async function copyRuntimeStatusText(value: string): Promise<boolean> {
  const copyWithElectron = window.electronAPI?.copyRuntimeStatusText;
  if (window.electronAPI?.isElectron === true && copyWithElectron) {
    return copyWithElectron(value);
  }
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Fall through for HTTP LAN pages without Clipboard API permission.
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  return copied;
}
