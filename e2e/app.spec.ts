import { expect, test } from "@playwright/test";

test("opens the stage-first chat interface and settings", async ({ page }, testInfo) => {
  const pageErrors: Error[] = [];
  page.on("pageerror", (error) => pageErrors.push(error));
  await page.goto("/");
  await expect(page.getByText("Live2D AI Chat", { exact: true })).toBeVisible();
  await expect(page.locator("canvas.stage-canvas")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".top-bar small")).toHaveText("就绪", { timeout: 15_000 });
  await expect(page.getByPlaceholder("输入消息…")).toBeVisible();
  await page.getByRole("button", { name: "打开设置" }).click();
  await expect(page.getByRole("heading", { name: "语言模型" })).toBeVisible();
  await expect(page.getByText("语音识别", { exact: true })).toBeVisible();
  await expect(page.getByText("语音合成", { exact: true })).toBeVisible();
  await expect(page.getByLabel("语言").first()).toHaveValue("en-US");
  await expect(page.getByLabel("语言").nth(1)).toHaveValue("en-US");

  await page.getByLabel("连接方式").selectOption("local");
  await expect(page.getByRole("button", { name: "↓ 下载模型" })).toBeVisible();
  await expect(page.getByRole("button", { name: "测试连接" })).toBeVisible();

  await page.getByLabel("模型").first().selectOption("__custom__");
  await expect(page.getByPlaceholder("输入模型名字")).toBeVisible();
  await expect(page.getByRole("link", { name: "搜索可用模型" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("settings.png"), fullPage: true });
  expect(pageErrors).toEqual([]);
});
