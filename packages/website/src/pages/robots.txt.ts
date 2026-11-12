export function GET() {
  const body = import.meta.env.WEBSITE_PRODUCTION
    ? `User-agent: *\nAllow: /\nSitemap: ${new URL("sitemap-index.xml", import.meta.env.SITE).href}\n`
    : "User-agent: *\nDisallow: /\n";
  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
