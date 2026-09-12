/** CLI argument grammar only; filesystem validation belongs to the host adapter. */
const resumeFlags: Record<string, string> = { pi: "--session" };
export function buildAgentResumeArgs(agent: string, thread: string): string[] {
  return [resumeFlags[agent] ?? "resume", thread];
}
