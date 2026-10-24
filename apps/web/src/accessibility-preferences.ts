export const ACCESSIBILITY_PREFERENCES_STORAGE_KEY =
  "accesshold.accessibility.preferences.v1";

export interface AccessibilityPreferences {
  highContrast: boolean;
  reduceMotion: boolean;
}

function systemPrefersReducedMotion(): boolean {
  if (
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function"
  ) {
    return false;
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function loadAccessibilityPreferences(): AccessibilityPreferences {
  const defaults: AccessibilityPreferences = {
    highContrast: false,
    reduceMotion: systemPrefersReducedMotion(),
  };
  if (typeof window === "undefined") return defaults;

  try {
    const serialized = window.localStorage.getItem(
      ACCESSIBILITY_PREFERENCES_STORAGE_KEY,
    );
    if (!serialized) return defaults;
    const stored = JSON.parse(serialized) as unknown;
    if (typeof stored !== "object" || stored === null) return defaults;

    const values = stored as Record<string, unknown>;
    return {
      highContrast:
        typeof values.highContrast === "boolean"
          ? values.highContrast
          : defaults.highContrast,
      reduceMotion:
        typeof values.reduceMotion === "boolean"
          ? values.reduceMotion
          : defaults.reduceMotion,
    };
  } catch {
    return defaults;
  }
}

export function persistAccessibilityPreferences(
  preferences: AccessibilityPreferences,
): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      ACCESSIBILITY_PREFERENCES_STORAGE_KEY,
      JSON.stringify(preferences),
    );
  } catch {
    // The UI still applies the current choice when storage is unavailable.
  }
}

export function applyAccessibilityPreferences(
  preferences: AccessibilityPreferences,
  root: HTMLElement = document.documentElement,
): void {
  root.dataset.contrast = preferences.highContrast ? "high" : "normal";
  root.dataset.reducedMotion = preferences.reduceMotion ? "reduce" : "normal";
}
