import { expect, test } from "@playwright/test";

test("opens the stage-first chat interface and settings", async ({ page }, testInfo) => {
  const pageErrors: Error[] = [];
  let chatRequests = 0;
  page.on("pageerror", (error) => pageErrors.push(error));
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.endsWith("/chat/completions")) chatRequests += 1;
  });
  await page.goto("/");
  await expect(page).toHaveTitle("Live2D AI");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByText("Live2D AI", { exact: true })).toBeVisible();
  await expect(page.locator("canvas.stage-canvas")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".top-bar small")).toHaveText("Ready", { timeout: 15_000 });
  await expect(page.getByRole("heading", { name: "Start a conversation" })).toBeVisible();
  await expect(page.getByText("Type a message or use the microphone.", { exact: true })).toBeVisible();
  await expect(page.locator(".subtitle")).toHaveCount(0);
  await expect(page.locator(".message-list")).toHaveCount(0);
  expect(chatRequests).toBe(0);
  await expect(page.getByPlaceholder("Type a message…")).toBeVisible();
  await page.getByRole("button", { name: "Open settings" }).click();
  await expect(page.getByRole("heading", { name: "Language model" })).toBeVisible();
  await expect(page.getByText("Speech recognition", { exact: true })).toBeVisible();
  await expect(page.getByText("Speech synthesis", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Language").first()).toHaveValue("en-US");
  await expect(page.getByLabel("Language").nth(1)).toHaveValue("en-US");

  await page.getByLabel("Connection").selectOption("local");
  await expect(page.getByRole("button", { name: "↓ Download model" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Test connection" })).toBeVisible();

  await page.getByLabel("Model").first().selectOption("__custom__");
  await expect(page.getByPlaceholder("Enter a model name")).toBeVisible();
  await expect(page.getByRole("link", { name: "Search for available models" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("settings.png"), fullPage: true });
  expect(pageErrors).toEqual([]);
});
