# AccessHold — Visual and Component Design

**Direction:** calm evidence desk
**Tokens:** [tokens.json](./tokens.json)
**Screens:** [WIREFRAMES.md](./WIREFRAMES.md) and [browser wireframes](./wireframe.html)

## 1. Design thesis

The interface should make a disrupted trip feel more understandable, not more dramatic. A narrow navy/teal evidence rail, generous warm-neutral whitespace, and explicit timestamps create a documentary hierarchy. Burnt orange is reserved for consequential actions; red is reserved for an actual violated hard constraint, never for stale or unknown evidence.

The design deliberately rejects the generated claymorphic/purple direction. AccessHold is a sensitive decision-support product, not a playful travel marketplace.

## 2. Layout system

### Responsive web

- Maximum content width 1280 px; 12-column desktop grid.
- Global header 64 px with product wordmark, current trip, privacy status, and account menu.
- Trip list uses a 4/8 split: trip summary rail left, current work right. It collapses to one column below 900 px.
- Contract editor uses 7/5 split: constraints left, evidence explanation right. Evidence is not hidden behind an icon.
- Recovery view orders content: change → affected requirements → options → unknowns → approval/handoff.
- Mobile preserves the same order and places the primary action after the content it approves, not in a floating bottom bar that hides details.

### Alexa rich card

Cards are at most 640 px equivalent width with three zones:

1. plain-language status and timestamp;
2. one evidence or comparison table;
3. one primary action and one secondary handoff/review action.

Long evidence documents open on web. Voice never becomes the only way to discover cost, terms, or unknowns.

## 3. Typography and data

- Source Sans 3 for all narrative and controls; system fallback is acceptable in prototypes.
- IBM Plex Mono/tabular figures for booking references, timestamps, prices, and plan hashes. Hashes are truncated with an accessible full-value label.
- Body 16 px minimum, secondary text 14 px minimum, page title 36 px desktop/30 px mobile.
- Status text never drops below 14 px merely to fit a badge; badges wrap into two lines.

## 4. Color and status grammar

| State | Treatment |
| --- | --- |
| Provider confirmed | Teal check icon + `Provider confirmed` + source/time |
| Documented | Blue document icon + `Documented` + source/time |
| Unknown/unverified | Hollow question icon + `Unknown` or `Not yet verified` |
| Stale/degraded | Amber clock icon + `Review needed` + last-current timestamp |
| Violated hard constraint | Red broken-link icon + `Requirement changed`; never full red page |
| Test/sandbox | Dashed border + `TEST PROVIDER` label in header and receipt |
| Awaiting confirmation | Hourglass icon + exact outstanding action; not a success check |

Status colors meet token contrast independently. Focus uses a 3 px burnt-orange outline with 2 px offset.

## 5. Component contracts

| Component | Anatomy and behavior | Accessibility/content requirement |
| --- | --- | --- |
| `AH-TripSummary` | Route/title, next date, current status, open-case count, `as of` time | Entire card is not a nested set of links; one named trip link |
| `AH-ConstraintRow` | Traveler wording, hard/preference label, applicable asset, evidence status, edit action | Hard constraint is text-first; row expands inline without losing focus |
| `AH-EvidenceBadge` | Icon, evidence level, source type, observed/expiry time | Never color-only; includes accessible source link name |
| `AH-EvidencePanel` | Source excerpt, scope, why it verifies/does not verify, stale explanation | Sanitized text only; document opens with short-lived authorized link |
| `AH-ChangeBanner` | Changed asset, old→new summary, affected hard constraints, review link | Uses `role=status`, not an assertive alert for routine changes |
| `AH-RecoveryOption` | Option title, exact itinerary/cost/terms, constraint coverage, unknowns, select control | Entire option is not a vague clickable card; radio has explicit label |
| `AH-UnknownList` | Unknown feature, why it matters, how to resolve/handoff | Appears before approval and is included in accessible option description |
| `AH-ApprovalSheet` | Exact action, price/terms, expiry, confirmation control, cancel | Recent-auth and plan version explained; destructive action never preselected |
| `AH-HandoffPacket` | Current status, included artifacts, recipient/channel, create action | Sensitive content warning and export access are explicit |
| `AH-EmptyState` | What is absent, why, next useful action | No travel-stock illustration or guilt-inducing copy |

## 6. Navigation and flows

Primary web navigation is `Trips`, `Recovery cases`, `Connections`, `Privacy`. On mobile these become a labelled menu, not unlabeled icons. The main task never requires opening chat.

Recovery selection uses a radio group followed by `Review selected recovery`. Approval is a separate step. `Request human handoff` remains visible at equal visual weight to secondary actions and is never hidden under `More`.

## 7. Motion and iconography

- 120–180 ms opacity/color transitions only; no parallax, bounce, confetti, or aircraft animations.
- New change enters with a subtle highlight and remains after animation; live regions do not repeatedly announce countdowns.
- Outlined document, shield, clock, link, and arrow icons from one SVG family. Emoji are not icons.
- Reduced-motion mode removes all nonessential transitions.

## 8. Charts and comparison

No decorative charts in the core flow. Recovery comparisons use a table with columns `Option`, `Hard requirements`, `Unknown`, `Cost`, `Terms`. On small screens each option becomes a labelled definition list. Costs and times use tabular figures.

## 9. Required visual states

Every major component specifies default, loading, empty, stale, error, offline, permission-denied, and success where applicable. Skeletons preserve final layout and do not shimmer under reduced motion. Offline copy includes last-current time and disables only actions that truly require connectivity.

## 10. Implementation handoff

React components consume semantic CSS variables generated from `tokens.json`. Evidence status is a domain enum mapped to exactly one presentation configuration; components must not independently reinterpret it. Rich cards reuse the same status/evidence view models as web rather than maintaining duplicate templates.
