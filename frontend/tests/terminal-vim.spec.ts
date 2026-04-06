import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

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
  const payload = (await response.json()) as {
    accessToken: string;
    expiresIn: number;
    sessionId: string;
  };

  await page.addInitScript(({ accessToken, expiresIn, sessionId }) => {
    const session = {
      accessToken,
      accessExpiresAt: Date.now() + expiresIn * 1000,
      sessionId,
    };
    window.localStorage.setItem("viewer.auth.token", JSON.stringify(session));
  }, payload);

  return payload.accessToken;
}

test("supports vim write/exit and preserves interaction through resize", async ({
  page,
  request,
}) => {
  const targetPath = "/tmp/viewer-vim-e2e.txt";

  await loginAndSeedToken(request, page);
  await page.goto("/");

  await page.getByRole("button", { name: "Open Terminal" }).click();

  await expect(page).toHaveURL(/\/terminal\//);
  await page.getByLabel("Terminal emulator").click({ force: true });

  await page.keyboard.type(`vim ${targetPath}`);
  await page.keyboard.press("Enter");

  await page.keyboard.press("i");
  await page.keyboard.type("viewer-vim-e2e");
  await page.setViewportSize({ width: 1180, height: 840 });
  await page.keyboard.type("-after-resize");
  await page.keyboard.press("Escape");
  await page.keyboard.type(":wq");
  await page.keyboard.press("Enter");

  await page.keyboard.type(`cat ${targetPath}`);
  await page.keyboard.press("Enter");

  await expect
    .poll(async () => {
      return await page.getByLabel("Terminal output").textContent();
    })
    .toContain("viewer-vim-e2e-after-resize");
});
