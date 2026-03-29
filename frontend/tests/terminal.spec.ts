import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const E2E_BACKEND_PORT = 5501;
const E2E_API_BASE = `http://127.0.0.1:${E2E_BACKEND_PORT}`;

async function loginAndSeedToken(
  request: APIRequestContext,
  page: Page,
): Promise<string> {
  const response = await request.post(`${E2E_API_BASE}/api/auth/login`, {
    data: {
      username: "e2e-admin",
      password: "e2e-secret",
    },
  });

  expect(response.ok()).toBe(true);
  const payload = (await response.json()) as { token: string };

  await page.addInitScript((token: string) => {
    window.localStorage.setItem("viewer.auth.token", token);
  }, payload.token);

  return payload.token;
}

test("creates a terminal session and streams command output", async ({
  page,
  request,
}) => {
  await loginAndSeedToken(request, page);
  await page.goto("/");

  await page.getByLabel("Terminal command").fill("bash");
  await page.getByLabel("Terminal cwd").fill("/tmp");
  await page.getByRole("button", { name: "Open Terminal" }).click();

  await expect(page).toHaveURL(/\/terminal\//);
  await expect(page.getByRole("heading", { name: "bash" })).toBeVisible();
  await page.getByLabel("Terminal emulator").click({ force: true });

  await page.keyboard.type("pwd");
  await page.keyboard.press("Enter");

  await expect
    .poll(async () => {
      return await page.getByLabel("Terminal output").textContent();
    })
    .toContain("/tmp");

  await page.keyboard.type("printf 'terminal-e2e-ok\\\\n'");
  await page.keyboard.press("Enter");

  await expect
    .poll(async () => {
      return await page.getByLabel("Terminal output").textContent();
    })
    .toContain("terminal-e2e-ok");
});
