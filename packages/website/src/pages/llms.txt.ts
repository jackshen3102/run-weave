export function GET() {
  const site = import.meta.env.SITE;
  const text = `# Runweave\n\nLocal-first AI CLI workspace. Agents run on your own machines; connect from desktop, web or phone.\n\n## Installation and first task\n- [Quick start](${new URL("/start/", site)}): Human-readable installation and first-use steps.\n- [Agent guide](${new URL("/agent-guide.txt", site)}): Plain-text commands, prerequisites, credential handling and verification.\n- [Source](https://github.com/jackshen3102/run-weave): Source and authoritative platform documentation.\n`;
  return new Response(text, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
