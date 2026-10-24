import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mediaDirectory = resolve(repoRoot, "docs/media");
const outputPath = resolve(mediaDirectory, "accesshold-demo.webm");
const baseUrl =
  process.env.DEMO_BASE_URL ?? "http://127.0.0.1:5173/accesshold/";
const viewport = { width: 1440, height: 1100 };

await mkdir(mediaDirectory, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport,
  recordVideo: { dir: mediaDirectory, size: viewport },
});
const page = await context.newPage();
const video = page.video();
if (!video) throw new Error("playwright_video_recording_not_started");
page.setDefaultTimeout(15_000);

let recordedPath: string | undefined;
try {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page
    .getByRole("heading", { name: "Trips and change queue" })
    .waitFor({ state: "visible" });

  await page.getByRole("button", { name: "Accessibility preferences" }).click();
  await page.getByRole("switch", { name: "High contrast mode" }).check();
  await page.waitForFunction(
    () => document.documentElement.dataset.contrast === "high",
  );
  await page
    .getByRole("button", { name: "Close accessibility preferences" })
    .click();

  await page.getByRole("button", { name: /Review disruption/ }).click();
  await page
    .getByRole("heading", { name: "A room detail needs review" })
    .waitFor({ state: "visible" });
  await page.getByRole("button", { name: /Review recovery options/ }).click();
  await page.getByRole("radio").first().check();
  await page.getByRole("button", { name: /Review selected recovery/ }).click();
  await page.getByText("Pending your approval").waitFor({ state: "visible" });
  await page.getByLabel(/Type APPROVE RECOVERY/).fill("APPROVE RECOVERY");
  await page.getByRole("button", { name: "Approve exact plan" }).click();
  await page.getByText("Approval recorded").waitFor({ state: "visible" });

  await page.getByRole("button", { name: "Execute fixture action" }).click();
  await page
    .getByText("Waiting for provider confirmation")
    .waitFor({ state: "visible" });
  await page.waitForTimeout(1_000);

  await page.close();
  recordedPath = await video.path();
} finally {
  await context.close().catch(() => undefined);
  await browser.close().catch(() => undefined);
}

if (!recordedPath) throw new Error("playwright_video_recording_missing");
await rm(outputPath, { force: true });
await rename(recordedPath, outputPath);
console.info(`Saved fixture-only demo video to ${outputPath}`);
