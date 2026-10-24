# Dashboard accessibility

The dashboard includes a persistent **Accessibility preferences** dialog with High Contrast Mode and Reduce Motion switches. Preferences are stored in browser local storage under `accesshold.accessibility.preferences.v1`. Reduce Motion defaults to the operating-system preference when no saved value exists. The operating system's reduced-motion setting is honored independently by CSS, even when the app preference is off.

## Keyboard and assistive technology

- The first keyboard stop is **Skip to main content**. Activating it focuses and scrolls to the main landmark.
- The page exposes the banner/header, named primary navigation, main content, workspace sidebar, and contentinfo/footer landmarks.
- The preferences dialog uses `role="dialog"` and `aria-modal="true"`. While it is open, the background application is inert and hidden from the accessibility tree. Tab and Shift+Tab remain inside the dialog; Escape closes it and restores focus to the invoking button.
- Recovery-plan actions and provider-question draft/send status changes are announced through separate, polite, atomic status regions. Errors use an alert region.
- Focus indicators are explicit, control targets have at least a 44-pixel minimum height where appropriate, and the layout reflows at narrow widths.

## Contrast

`tests/unit/accessibility-contrast.test.ts` calculates WCAG relative-luminance contrast ratios from the actual theme and page CSS. It covers body/muted text, buttons, status and notice treatments, labels, and accessibility settings against their defined backgrounds. The tested normal-mode text pairs meet the WCAG 2.1 AA 4.5:1 threshold. High Contrast Mode uses white text on black surfaces (21:1), white boundaries, and a yellow keyboard-focus outline. The dashboard also honors the browser's forced-colors mode.

The contrast test is a token/component-pair audit, not an automated proof of every rendered state. The E2E suite runs in jsdom and verifies preference persistence, keyboard navigation, focus trapping, and landmarks, but does not render browser pixels or test a screen reader. Browser/assistive-technology checks and testing with travelers remain release work.
