# AccessHold — Low-Fidelity Wireframes

Open [wireframe.html](./wireframe.html) in a browser. The page is a static, responsive annotation of five screens; it is not a connected prototype. All records are clearly fictional, all times are explicit, and provider evidence is illustrative.

## Screen inventory

| Anchor | Screen | Purpose | Primary path |
| --- | --- | --- | --- |
| `#trips` | Trips and change queue | Find current trip, understand evidence freshness, open a recovery case | Open changed trip |
| `#contract` | Access Contract editor | Review traveler requirements and verification coverage | Add/edit a hard constraint |
| `#recovery` | Disruption recovery | Compare replacement options before any commitment | Select, review, then request handoff/approval |
| `#handoff` | Human handoff packet | See exactly what leaves the system and what remains unknown | Create scoped packet |
| `#card` | Alexa recovery card | Understand the change and reach full details from a voice companion surface | Compare options or request handoff |

## 1. Trips and change queue

**Layout:** trip summary rail at left; active disruption and current itinerary at right. Header exposes `TEST PROVIDER` and last sync time.

**Fictional content:** Amsterdam → Copenhagen trip, one rail segment changed, seat assistance requirement affected.

**Annotations**

- Provider confirmed, documented, and unknown evidence use different icon/text treatments.
- The changed segment states old and new times, not just `Schedule updated`.
- The primary action is `Review recovery options`; `Continue monitoring` is secondary.

**State variants:** no trips; no changes; sync in progress; stale evidence; provider permission denied; offline with cached trip.

## 2. Access Contract editor

**Layout:** requirement list left, selected requirement/evidence detail right. Hard constraints appear before preferences.

**Fictional content:** step-free boarding as a hard constraint; quiet coach as preference; coverage matrix shows what the current provider can and cannot verify.

**Annotations**

- `Not yet verified` does not imply violation.
- Saving the contract does not execute a booking.
- Evidence panel names the source, observation time, scope, and exact gap.

**State variants:** valid draft; invalid missing applicability; unsaved changes; stale source; conflicting evidence; read-only version already used for a plan.

## 3. Disruption recovery

**Layout:** change banner, affected requirements, two recovery option comparisons, shared unknowns, selection and review action.

**Fictional content:** two trains with different transfer risk and terms. Option A meets all known hard requirements but has one unverified boarding detail; Option B violates step-free transfer and is not selectable as equivalent.

**Annotations**

- Constraint coverage is option-specific.
- Cost, terms, expiry, and unknowns precede the selection review.
- Approval and handoff are separate destinations; no option is preselected.

**State variants:** no safe option; expired plan; recent-auth required; provider write unavailable; action accepted with provider ID; ambiguous result requiring reconciliation.

## 4. Human handoff packet

**Layout:** status summary, included artifacts checklist, recipient/channel controls, sensitive-data notice, packet preview.

**Fictional content:** selected option plus contract excerpts and unknowns; raw credentials and full payment data are explicitly excluded.

**Annotations**

- Packet creation is not represented as a completed provider booking.
- Export includes plan ID and evidence times for later reconciliation.
- Mobile stacks preview before action and retains a visible cancel/back route.

**State variants:** draft; creating; link ready; delivery failed; expired link; revoked; downloaded audit record.

## 5. Alexa recovery card

**Layout:** plain-language change summary, one compact option, evidence time, and links to full comparison/handoff.

**Annotations**

- Card content and voice share the same evidence state.
- Full terms and long evidence remain on web.
- No direct purchase control or success implication appears on the card.

**State variants:** no change; review needed; option selected; handoff ready; stale card; account linking required.

## Flow contract

`Trips → Review changed requirement → Compare recovery → Review exact action → Provider approval OR human handoff → Reconcile result`

At any point, a stale/unknown state can route back to evidence review. Browser controls demonstrate navigation only; they do not authorize actions, call providers, or persist data.
