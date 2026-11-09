/** Shell classification shared by launch owners; this does not imply integration support. */
export function terminalShellName(command: string): string {
  return (command.split(/[\\/]/).at(-1) ?? command).toLowerCase().replace(/\.exe$/, "");
}

export function isInteractiveShellLaunch(launch: { command: string; args?: readonly string[] }): boolean {
  const name = terminalShellName(launch.command);
  if (!["sh", "bash", "zsh", "dash", "ksh", "fish", "powershell", "pwsh", "cmd"].includes(name)) return false;
  return !(launch.args ?? []).some(arg => {
    const value = arg.toLowerCase();
    // Be conservative: a script operand, command mode or an option's operand
    // must not be reinterpreted as an interactive shell after failure.
    if (name === "cmd") return !/^\/(?:d|q|a|u|e:(?:on|off)|f:(?:on|off)|v:(?:on|off))$/.test(value);
    if (name === "powershell" || name === "pwsh") return !["-nologo", "-noprofile", "-noexit", "-login", "-l"].includes(value);
    return ["--help", "--version"].includes(value) || !value.startsWith("-") || value === "--" || /^-[^-]*[cs]/.test(value) || /^--(?:command|init-command)(?:=|$)/.test(value);
  });
}
