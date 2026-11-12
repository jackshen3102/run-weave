import { agentGuide } from "../data/quickstart";
export function GET() {
  return new Response(agentGuide, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
