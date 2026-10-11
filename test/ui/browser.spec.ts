import { test, expect } from "@playwright/test";
const app = (page: import("@playwright/test").Page) =>
  page.frameLocator("iframe");
test("navigate, search, preview and explicitly add one file to chat", async ({
  page,
}) => {
  await page.goto("/qa.html");
  const ui = app(page);
  await expect(ui.getByText("6 items", { exact: true })).toBeVisible();
  await ui.getByRole("button", { name: "Projects", exact: true }).click();
  await expect(ui.getByText("This folder is empty.")).toBeVisible();
  await ui.getByRole("button", { name: "Documents", exact: true }).click();
  await expect(ui.getByText("6 items", { exact: true })).toBeVisible();
  await ui.getByRole("textbox", { name: "Search file names" }).fill("welcome");
  await ui.getByRole("button", { name: "Search", exact: true }).click();
  await expect(ui.getByText("1 matches", { exact: true })).toBeVisible();
  await ui.getByRole("button", { name: "Welcome.md", exact: true }).click();
  await expect(ui.locator("pre")).toContainText(
    "Your files, close to the conversation.",
  );
  let events = await page.evaluate(() => (window as any).__events);
  expect(
    events.some(
      (e: any) =>
        e.method === "ui/update-model-context" || e.method === "ui/message",
    ),
  ).toBe(false);
  await ui.getByRole("button", { name: "Use in conversation" }).click();
  await expect(ui.getByText("Added to conversation.")).toBeVisible();
  events = await page.evaluate(() => (window as any).__events);
  expect(
    events.filter(
      (e: any) => e.method === "tools/call" && e.params.name === "select_file",
    ),
  ).toHaveLength(1);
  expect(events.some((e: any) => e.method === "ui/update-model-context")).toBe(
    true,
  );
  expect(events.some((e: any) => e.method === "ui/message")).toBe(true);
});
test("unsupported documents remain metadata only", async ({ page }) => {
  await page.goto("/qa.html");
  const ui = app(page);
  await ui.getByRole("button", { name: "Handbook.pdf" }).click();
  await expect(
    ui.getByText("Preview is not available for this file type or size yet."),
  ).toBeVisible();
  await expect(
    ui.getByRole("button", { name: "Use in conversation" }),
  ).toBeDisabled();
});
test("shows failures and can retry without claiming successful selection", async ({
  page,
}) => {
  await page.goto("/qa.html");
  const ui = app(page);
  await ui.getByRole("button", { name: "Welcome.md" }).click();
  await page.evaluate(() => {
    (window as any).__failure = "ui/message";
  });
  await ui.getByRole("button", { name: "Use in conversation" }).click();
  await expect(ui.getByRole("alert")).toContainText("could not send");
  await expect(ui.getByText("Added to conversation.")).toHaveCount(0);
});
test("renders untrusted file content as text", async ({ page }) => {
  await page.goto("/qa.html");
  const ui = app(page);
  await ui.getByRole("button", { name: "Packing list.txt" }).click();
  await expect(ui.locator("pre")).toHaveText(
    '<script>alert("unsafe")</script>',
  );
  await expect(ui.locator("pre script")).toHaveCount(0);
});
test("desktop and narrow layouts remain usable", async ({ page }) => {
  await page.goto("/qa.html");
  const ui = app(page);
  await ui.getByRole("button", { name: "Welcome.md" }).click();
  await ui
    .locator(".app")
    .screenshot({ path: "test-results/browser-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    ui.getByRole("button", { name: "Use in conversation" }),
  ).toBeVisible();
  const widths = await ui
    .locator("body")
    .evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.client);
  await page.screenshot({ path: "test-results/browser-mobile-list.png" });
  const useFile = ui.getByRole("button", { name: "Use in conversation" });
  await useFile.scrollIntoViewIfNeeded();
  await expect(useFile).toBeInViewport();
  await page.screenshot({ path: "test-results/browser-mobile.png" });
  await useFile.click();
  await expect(ui.getByText("Added to conversation.")).toBeVisible();
});
