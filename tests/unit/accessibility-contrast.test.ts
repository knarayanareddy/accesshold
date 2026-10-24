import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function projectFile(relativePath: string): string {
  return fileURLToPath(new URL(`../../${relativePath}`, import.meta.url));
}

const themeCss = readFileSync(projectFile("ui/theme.css"), "utf8");
const pageCss = readFileSync(projectFile("apps/web/src/styles.css"), "utf8");

function declarationsFor(css: string, selector: string): string {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const rule of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = rule[1]?.split(",").map((item) => item.trim());
    if (selectors?.includes(selector) && rule[2]) return rule[2];
  }
  throw new Error(`css_rule_not_found:${selector}`);
}

function cssColor(declarations: string, property: string): string {
  const match = declarations.match(
    new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*(#[0-9a-fA-F]{6})`),
  );
  if (!match?.[1]) throw new Error(`css_color_not_found:${property}`);
  return match[1];
}

function themeToken(token: string): string {
  const root = declarationsFor(themeCss, ":root");
  const match = root.match(
    new RegExp(`(?:^|;)\\s*${token}\\s*:\\s*(#[0-9a-fA-F]{6})`),
  );
  if (!match?.[1]) throw new Error(`theme_token_not_found:${token}`);
  return match[1];
}

function linearize(channel: number): number {
  const normalized = channel / 255;
  return normalized <= 0.04045
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const value = hex.replace("#", "");
  return (
    0.2126 * linearize(Number.parseInt(value.slice(0, 2), 16)) +
    0.7152 * linearize(Number.parseInt(value.slice(2, 4), 16)) +
    0.0722 * linearize(Number.parseInt(value.slice(4, 6), 16))
  );
}

function contrastRatio(foreground: string, background: string): number {
  const values = [luminance(foreground), luminance(background)].sort(
    (left, right) => right - left,
  );
  return (values[0]! + 0.05) / (values[1]! + 0.05);
}

describe("WCAG 2.1 AA color contrast tokens", () => {
  it("keeps normal-mode body, labels, controls, and status text at 4.5:1", () => {
    const pairs: Array<{
      label: string;
      foreground: string;
      background: string;
    }> = [
      {
        label: "body text on canvas",
        foreground: themeToken("--text"),
        background: themeToken("--canvas"),
      },
      {
        label: "muted text on surface",
        foreground: themeToken("--muted"),
        background: themeToken("--surface"),
      },
      {
        label: "primary button",
        foreground: themeToken("--on-primary"),
        background: themeToken("--primary"),
      },
      {
        label: "accent button",
        foreground: themeToken("--on-accent"),
        background: themeToken("--accent"),
      },
      {
        label: "success status",
        foreground: cssColor(
          declarationsFor(pageCss, ".status-success"),
          "color",
        ),
        background: cssColor(
          declarationsFor(pageCss, ".status-success"),
          "background",
        ),
      },
      {
        label: "warning status",
        foreground: cssColor(
          declarationsFor(pageCss, ".status-warning"),
          "color",
        ),
        background: cssColor(
          declarationsFor(pageCss, ".status-warning"),
          "background",
        ),
      },
      {
        label: "danger status",
        foreground: cssColor(
          declarationsFor(pageCss, ".status-danger"),
          "color",
        ),
        background: cssColor(
          declarationsFor(pageCss, ".status-danger"),
          "background",
        ),
      },
      {
        label: "neutral status",
        foreground: cssColor(
          declarationsFor(pageCss, ".status-neutral"),
          "color",
        ),
        background: cssColor(
          declarationsFor(pageCss, ".status-neutral"),
          "background",
        ),
      },
      {
        label: "warning notice",
        foreground: cssColor(
          declarationsFor(pageCss, ".notice-warning"),
          "color",
        ),
        background: cssColor(
          declarationsFor(pageCss, ".notice-warning"),
          "background",
        ),
      },
      {
        label: "success notice",
        foreground: cssColor(
          declarationsFor(pageCss, ".notice-success"),
          "color",
        ),
        background: cssColor(
          declarationsFor(pageCss, ".notice-success"),
          "background",
        ),
      },
      {
        label: "error message",
        foreground: cssColor(
          declarationsFor(pageCss, ".error-banner"),
          "color",
        ),
        background: cssColor(
          declarationsFor(pageCss, ".error-banner"),
          "background",
        ),
      },
      {
        label: "navigation index",
        foreground: cssColor(declarationsFor(pageCss, ".nav-number"), "color"),
        background: themeToken("--surface"),
      },
      {
        label: "heading separator",
        foreground: cssColor(
          declarationsFor(pageCss, ".eyebrow-separator"),
          "color",
        ),
        background: themeToken("--surface"),
      },
      {
        label: "option metadata labels",
        foreground: cssColor(
          declarationsFor(pageCss, ".option-meta-grid span"),
          "color",
        ),
        background: themeToken("--surface"),
      },
      {
        label: "accessibility setting description",
        foreground: themeToken("--muted"),
        background: cssColor(
          declarationsFor(pageCss, ".accessibility-setting-row"),
          "background",
        ),
      },
    ];

    for (const pair of pairs) {
      expect(
        contrastRatio(pair.foreground, pair.background),
        `${pair.label} must meet WCAG AA for normal-size text`,
      ).toBeGreaterThanOrEqual(4.5);
    }
    expect(
      contrastRatio(themeToken("--focus"), themeToken("--canvas")),
      "the default focus indicator must contrast with the page canvas",
    ).toBeGreaterThanOrEqual(3);
  });

  it("uses a verified high-contrast palette with 21:1 text contrast", () => {
    const highContrastRule = declarationsFor(
      pageCss,
      ':root[data-contrast="high"] :where(*)',
    );
    const foreground = cssColor(highContrastRule, "color");
    const background = cssColor(highContrastRule, "background-color");

    expect(contrastRatio(foreground, background)).toBe(21);
    expect(foreground).toBe("#ffffff");
    expect(background).toBe("#000000");
    const highContrastRoot = declarationsFor(
      pageCss,
      ':root[data-contrast="high"]',
    );
    const focus = cssColor(highContrastRoot, "--focus");
    expect(contrastRatio(focus, background)).toBeGreaterThanOrEqual(7);
  });
});
