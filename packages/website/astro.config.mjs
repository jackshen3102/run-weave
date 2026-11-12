import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";

const environment = process.env.WEBSITE_ENV ?? "preview";
if (!["preview", "production"].includes(environment)) {
  throw new Error("WEBSITE_ENV must be preview or production");
}
const production = environment === "production";
const configuredSite = process.env.WEBSITE_SITE_URL;
if (production && !configuredSite) {
  throw new Error(
    "Production build requires WEBSITE_SITE_URL with the real HTTPS site address",
  );
}
const site = new URL(configuredSite ?? "http://127.0.0.1:4321");
if (
  !["http:", "https:"].includes(site.protocol) ||
  site.username ||
  site.password ||
  site.search ||
  site.hash ||
  site.pathname !== "/"
) {
  throw new Error(
    "WEBSITE_SITE_URL must be an HTTP(S) site root without credentials, query or fragment",
  );
}
if (
  production &&
  (site.protocol !== "https:" ||
    /^(localhost|.*\.localhost|127\..*|\[::1\])$/i.test(site.hostname))
) {
  throw new Error("Production WEBSITE_SITE_URL must be a public HTTPS address");
}
const claritySetting = process.env.WEBSITE_CLARITY_ENABLED;
if (
  claritySetting !== undefined &&
  !["true", "false"].includes(claritySetting)
) {
  throw new Error("WEBSITE_CLARITY_ENABLED must be true or false");
}
const clarityProject = (
  process.env.WEBSITE_CLARITY_PROJECT_ID ?? "zc99skixyj"
).trim();
const clarityEnabled = production && claritySetting !== "false";
if (clarityEnabled && !/^[a-zA-Z0-9]+$/.test(clarityProject)) {
  throw new Error(
    "WEBSITE_CLARITY_PROJECT_ID must be a nonempty alphanumeric project ID",
  );
}
export default defineConfig({
  site: site.origin,
  output: "static",
  devToolbar: { enabled: false },
  integrations: production
    ? [
        sitemap({
          filter: (page) => ["/", "/start/"].includes(new URL(page).pathname),
        }),
      ]
    : [],
  vite: {
    define: {
      "import.meta.env.WEBSITE_PRODUCTION": JSON.stringify(production),
      "import.meta.env.WEBSITE_CLARITY_ENABLED": JSON.stringify(clarityEnabled),
      "import.meta.env.WEBSITE_CLARITY_PROJECT_ID":
        JSON.stringify(clarityProject),
    },
  },
});
