import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mediaDirectory = resolve(repoRoot, "docs/media");
const outputPath = resolve(mediaDirectory, "accesshold-demo.webm");
const captionsPath = resolve(mediaDirectory, "accesshold-demo.en.vtt");
const chaptersPath = resolve(mediaDirectory, "accesshold-demo.chapters.vtt");
const baseUrl =
  process.env.DEMO_BASE_URL ?? "http://127.0.0.1:5173/accesshold/";
const viewport = { width: 1440, height: 1100 };

function formatVttTimestamp(seconds: number): string {
  const milliseconds = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const remainingSeconds = Math.floor((milliseconds % 60_000) / 1000);
  const remainder = milliseconds % 1000;
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(remainingSeconds)}.${pad(remainder, 3)}`;
}

function cue(start: number, end: number, text: string): string {
  return `${formatVttTimestamp(start)} --> ${formatVttTimestamp(end)}\n${text}`;
}

await mkdir(mediaDirectory, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
    : {}),
  ...(process.env.PLAYWRIGHT_CHROMIUM_ARGS_JSON
    ? {
        args: JSON.parse(process.env.PLAYWRIGHT_CHROMIUM_ARGS_JSON) as string[],
      }
    : {}),
});
const context = await browser.newContext({
  viewport,
  recordVideo: { dir: mediaDirectory, size: viewport },
});
const page = await context.newPage();
const video = page.video();
if (!video) throw new Error("playwright_video_recording_not_started");
page.setDefaultTimeout(15_000);
const recordingStartedAt = performance.now();
const elapsedSeconds = () => (performance.now() - recordingStartedAt) / 1000;
const timeline: {
  delayNotification?: number;
  recoveryPlan?: number;
  approvalRecorded?: number;
  fixtureAction?: number;
} = {};

let recordedPath: string | undefined;
let recordedDuration: number | undefined;
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
  await page.waitForTimeout(22_000);
  await page
    .getByRole("button", { name: "Close accessibility preferences" })
    .click();

  timeline.delayNotification = elapsedSeconds();
  await page.getByRole("button", { name: /Review disruption/ }).click();
  await page
    .getByRole("heading", { name: "A room detail needs review" })
    .waitFor({ state: "visible" });
  await page.waitForTimeout(24_000);
  await page.getByRole("button", { name: /Review recovery options/ }).click();
  await page
    .getByRole("heading", { name: "Review recovery options" })
    .waitFor({ state: "visible" });
  timeline.recoveryPlan = elapsedSeconds();
  await page.waitForTimeout(20_000);
  await page.getByRole("radio").first().check();
  await page.waitForTimeout(8_000);
  await page.getByRole("button", { name: /Review selected recovery/ }).click();
  await page.getByText("Pending your approval").waitFor({ state: "visible" });
  await page.waitForTimeout(10_000);
  await page.getByLabel(/Type APPROVE RECOVERY/).fill("APPROVE RECOVERY");
  await page.waitForTimeout(14_000);
  await page.getByRole("button", { name: "Approve exact plan" }).click();
  await page.getByText("Approval recorded").waitFor({ state: "visible" });
  timeline.approvalRecorded = elapsedSeconds();
  await page.waitForTimeout(15_000);

  await page.getByRole("button", { name: "Execute fixture action" }).click();
  await page
    .getByText("Waiting for provider confirmation")
    .waitFor({ state: "visible" });
  timeline.fixtureAction = elapsedSeconds();
  await page.waitForTimeout(15_000);
  recordedDuration = elapsedSeconds();

  await page.close();
  recordedPath = await video.path();
} finally {
  await context.close().catch(() => undefined);
  await browser.close().catch(() => undefined);
}

if (!recordedPath || recordedDuration === undefined) {
  throw new Error("playwright_video_recording_incomplete");
}
await rm(outputPath, { force: true });
await rename(recordedPath, outputPath);

const narrationPath = resolve(mediaDirectory, "accesshold-narration.mp3");
if (existsSync(narrationPath)) {
  const tempMux = `${outputPath}.mux.webm`;
  const muxRes = spawnSync("ffmpeg", [
    "-y",
    "-i",
    outputPath,
    "-i",
    narrationPath,
    "-c:v",
    "copy",
    "-c:a",
    "libopus",
    "-b:a",
    "128k",
    "-shortest",
    tempMux,
  ]);
  if (muxRes.status === 0 && existsSync(tempMux)) {
    await rename(tempMux, outputPath);
  }
}
spawnSync("ffmpeg", [
  "-y",
  "-i",
  outputPath,
  "-c:v",
  "libx264",
  "-pix_fmt",
  "yuv420p",
  "-c:a",
  "aac",
  "-b:a",
  "128k",
  outputPath.replace(/\.webm$/, ".mp4"),
]);

const delayStart = Math.max(1, timeline.delayNotification ?? 5);
const recoveryStart = Math.max(
  delayStart + 1,
  timeline.recoveryPlan ?? delayStart + 5,
);
const approvalStart = Math.max(
  recoveryStart + 1,
  timeline.approvalRecorded ?? recoveryStart + 5,
);
const actionStart = Math.max(
  approvalStart + 0.5,
  timeline.fixtureAction ?? approvalStart + 1,
);
const end = Math.max(recordedDuration + 0.5, actionStart + 0.5);

const captions = [
  "WEBVTT",
  "",
  cue(
    0,
    delayStart,
    "[High Contrast Mode is enabled. The dashboard uses bright text, dark backgrounds, and clear focus outlines.]",
  ),
  "",
  cue(
    delayStart,
    recoveryStart,
    "[Synthetic TEST PROVIDER disruption notice reviewed: a room access detail changed. No live itinerary is polled.]",
  ),
  "",
  cue(
    recoveryStart,
    approvalStart,
    "[The traveler reviews recovery options and unknowns, then types APPROVE RECOVERY for the exact plan.]",
  ),
  "",
  cue(
    approvalStart,
    actionStart,
    "[Approval is recorded for this plan only. The fixture action has not yet been executed.]",
  ),
  "",
  cue(
    actionStart,
    end,
    "[TEST PROVIDER fixture action recorded. Provider confirmation remains pending; no live booking was changed.]",
  ),
  "",
].join("\n");
const chapters = [
  "WEBVTT",
  "",
  cue(0, delayStart, "1: High Contrast"),
  "",
  cue(delayStart, recoveryStart, "2: Delay Notification"),
  "",
  cue(recoveryStart, end, "3: Recovery Plan Approval"),
  "",
].join("\n");
await writeFile(captionsPath, captions, "utf8");
await writeFile(chaptersPath, chapters, "utf8");
console.info(`Saved fixture-only demo video to ${outputPath}`);
console.info(`Saved English captions and chapters to ${mediaDirectory}`);
