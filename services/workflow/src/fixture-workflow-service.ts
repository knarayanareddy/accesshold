import { createHash } from "node:crypto";
import type { AccessContractDocument } from "../../../packages/contracts/src/index.js";
import type {
  FixtureActionReceipt,
  RecoveryPlan,
} from "../../recovery/src/fixture-recovery-service.js";

export interface HandoffPacket {
  packet_id: string;
  case_id: string;
  trip_id: string;
  contract_version: number;
  recipient: string;
  reason: string;
  itinerary: {
    trip: AccessContractDocument["trip"];
    assets: AccessContractDocument["assets"];
  };
  constraints: AccessContractDocument["constraints"];
  evidence: AccessContractDocument["evidence"];
  attempted_actions: FixtureActionReceipt[];
  unknowns: string[];
  created_at: string;
  provenance: "fixture";
  live_handoff: false;
}

export interface HandoffResult {
  packet: HandoffPacket;
  duplicate: boolean;
}

export interface FixtureCalendarUpdate {
  update_id: string;
  trip_id: string;
  external_event_id: string;
  confirmed_contract_version: number;
  starts_at: string;
  ends_at: string;
  time_zone: string;
  status: "fixture_update_recorded";
  external_update: false;
  recorded_at: string;
}

export interface CalendarResult {
  update: FixtureCalendarUpdate;
  duplicate: boolean;
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`)
    .join("")}}`;
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function requireActor(document: AccessContractDocument, actor: string): void {
  if (document.traveler_id !== actor) throw new Error("trip_access_denied");
}

function requireFixtureDocument(document: AccessContractDocument): void {
  if (document.provenance !== "fixture" || !document.trip.trip_id.trim()) {
    throw new Error("fixture_workflow_document_required");
  }
}

/** Builds a human-review packet only; it does not send email or contact a provider. */
export class FixtureHandoffService {
  private readonly packets = new Map<string, HandoffPacket>();

  constructor(private readonly clock: () => Date = () => new Date()) {}

  requestHandoff(input: {
    document: AccessContractDocument;
    caseId: string;
    actorTravelerId: string;
    reason: string;
    plan?: RecoveryPlan;
    receipt?: FixtureActionReceipt;
    unknowns?: string[];
  }): HandoffResult {
    const { document } = input;
    requireFixtureDocument(document);
    requireActor(document, input.actorTravelerId);
    if (
      document.status === "draft" ||
      !input.caseId.trim() ||
      !input.reason.trim() ||
      input.reason.length > 500 ||
      !document.approval_policy.human_handoff_contact.trim()
    ) {
      throw new Error("invalid_handoff_request");
    }
    if (input.plan) {
      if (
        input.plan.case_id !== input.caseId ||
        input.plan.trip_id !== document.trip.trip_id ||
        input.plan.contract_version > document.version
      ) {
        throw new Error("handoff_plan_binding_mismatch");
      }
    }
    if (input.receipt) {
      if (
        !input.plan ||
        input.receipt.plan_hash !== input.plan.plan_hash ||
        input.receipt.case_id !== input.caseId ||
        input.receipt.live_action ||
        input.receipt.provider !== "TEST PROVIDER"
      ) {
        throw new Error("handoff_receipt_binding_mismatch");
      }
    }
    const unknowns = [
      ...new Set([
        ...(input.plan?.option.unknowns ?? []),
        ...(input.unknowns ?? []),
      ]),
    ];
    if (unknowns.some((item) => !item.trim() || item.length > 500)) {
      throw new Error("invalid_handoff_unknown");
    }
    const unsigned = {
      case_id: input.caseId,
      trip_id: document.trip.trip_id,
      contract_version: document.version,
      recipient: document.approval_policy.human_handoff_contact,
      reason: input.reason,
      itinerary: {
        trip: clone(document.trip),
        assets: clone(document.assets),
      },
      constraints: clone(document.constraints),
      evidence: clone(document.evidence),
      attempted_actions: input.receipt ? [clone(input.receipt)] : [],
      unknowns,
      provenance: "fixture" as const,
      live_handoff: false as const,
    };
    const packetId = `handoff-${fingerprint(unsigned).slice(0, 24)}`;
    const existing = this.packets.get(packetId);
    if (existing) return { packet: clone(existing), duplicate: true };
    const now = this.clock();
    if (!Number.isFinite(now.getTime()))
      throw new Error("invalid_handoff_clock");
    const packet: HandoffPacket = {
      ...unsigned,
      packet_id: packetId,
      created_at: now.toISOString(),
    };
    this.packets.set(packetId, packet);
    return { packet: clone(packet), duplicate: false };
  }

  get packetCount(): number {
    return this.packets.size;
  }
}

/**
 * Records calendar intent for a confirmed fixture itinerary. The outbox is local;
 * an external calendar adapter must consume it separately and is not implemented.
 */
export class FixtureCalendarService {
  private readonly updates = new Map<string, FixtureCalendarUpdate>();
  private readonly latestVersionByTrip = new Map<string, number>();

  constructor(private readonly clock: () => Date = () => new Date()) {}

  updateConfirmedItinerary(input: {
    document: AccessContractDocument;
    completedPlan: RecoveryPlan;
    actorTravelerId: string;
    externalEventId: string;
    requestId: string;
  }): CalendarResult {
    const { document, completedPlan } = input;
    requireFixtureDocument(document);
    requireActor(document, input.actorTravelerId);
    if (
      document.status !== "active" ||
      completedPlan.state !== "completed" ||
      completedPlan.trip_id !== document.trip.trip_id ||
      document.version <= completedPlan.contract_version ||
      !document.approval_policy.allowed_actions.includes("calendar_update") ||
      !input.externalEventId.trim() ||
      !input.requestId.trim()
    ) {
      throw new Error("confirmed_itinerary_required_for_calendar_update");
    }
    const latest = this.latestVersionByTrip.get(document.trip.trip_id);
    if (latest !== undefined && document.version < latest) {
      throw new Error("stale_confirmed_itinerary_version");
    }
    const unsigned = {
      trip_id: document.trip.trip_id,
      external_event_id: input.externalEventId,
      confirmed_contract_version: document.version,
      starts_at: document.trip.starts_at,
      ends_at: document.trip.ends_at,
      time_zone: document.trip.time_zone,
      status: "fixture_update_recorded" as const,
      external_update: false as const,
    };
    const updateId = `calendar-${fingerprint(unsigned).slice(0, 24)}`;
    const existing = this.updates.get(updateId);
    if (existing) return { update: clone(existing), duplicate: true };
    if (latest === document.version) {
      throw new Error("conflicting_calendar_update_for_confirmed_version");
    }
    const now = this.clock();
    if (!Number.isFinite(now.getTime()))
      throw new Error("invalid_calendar_clock");
    const update: FixtureCalendarUpdate = {
      ...unsigned,
      update_id: updateId,
      recorded_at: now.toISOString(),
    };
    this.updates.set(updateId, update);
    this.latestVersionByTrip.set(document.trip.trip_id, document.version);
    return { update: clone(update), duplicate: false };
  }

  get updateCount(): number {
    return this.updates.size;
  }
}
