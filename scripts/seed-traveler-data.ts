import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type {
  AccessAsset,
  AccessConstraint,
  AccessContractDocument,
  AccessEvidence,
  Feature,
  Predicate,
} from "../packages/contracts/src/index.js";
import { validateAccessContractSemantics } from "../packages/contracts/src/index.js";
import type { FeatureRegistry } from "../packages/policy-engine/src/index.js";
import type { FixtureRecoveryOption } from "../services/recovery/src/fixture-recovery-service.js";
import type { ContractRepository } from "../services/importer/src/contract-repository.js";
import {
  ContractRepositoryFactory,
  type ContractRepositoryDriver,
} from "../services/importer/src/contract-repository-factory.js";

const SEED_VERSION = 1 as const;
const SEED_AS_OF = "2026-10-24T10:00:00.000Z";
const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export interface PrecalculatedRebookingOption extends FixtureRecoveryOption {
  requires_traveler_approval: true;
  live_action: false;
}

export interface PrecalculatedProviderRequestOption {
  option_id: string;
  summary: string;
  action: "prepare_provider_request";
  asset_id: string;
  asset_version: number;
  evidence_id: string;
  evidence_version: number;
  provider_question: string;
  amount_minor: number;
  currency: string;
  terms: string;
  expires_at: string;
  unknowns: string[];
  requires_traveler_approval: true;
  live_action: false;
}

export type PrecalculatedRecoveryOption =
  | PrecalculatedRebookingOption
  | PrecalculatedProviderRequestOption;

export interface SeededDisruptionScenario {
  scenario_id: string;
  case_id: string;
  trip_id: string;
  asset_id: string;
  constraint_ids: string[];
  kind: "flight_delay" | "gate_change";
  provenance: "fixture";
  generated_at: string;
  event: {
    detected_at: string;
    summary: string;
    original: {
      departure_at: string;
      arrival_at: string;
      gate: string | null;
    };
    updated: {
      departure_at: string;
      arrival_at: string;
      gate: string | null;
    };
  };
  precalculated_options: PrecalculatedRecoveryOption[];
  no_action: {
    option_id: "no_action";
    summary: string;
    unknowns: string[];
  };
}

export interface DemoTravelerSeedBundle {
  seed_version: typeof SEED_VERSION;
  generated_at: string;
  provenance: "fixture";
  traveler_id: string;
  contracts: AccessContractDocument[];
  scenarios: SeededDisruptionScenario[];
}

export interface TravelerSeedRepositoryResult {
  inserted_trip_ids: string[];
  existing_trip_ids: string[];
}

interface SeedAssetSpec {
  key: string;
  kind: AccessAsset["kind"];
  provider: string;
  provider_reference: string;
  starts_at: string;
  ends_at: string;
  attributes: Feature[];
}

interface SeedConstraintSpec {
  key: string;
  traveler_text: string;
  asset_key: string;
  predicate: Predicate;
}

interface SeedTripSpec {
  key: string;
  title: string;
  starts_at: string;
  ends_at: string;
  assets: SeedAssetSpec[];
  constraints: SeedConstraintSpec[];
}

function projectPath(relativePath: string): string {
  return fileURLToPath(new URL(`../${relativePath}`, import.meta.url));
}

async function readJson<T>(relativePath: string): Promise<T> {
  return JSON.parse(await readFile(projectPath(relativePath), "utf8")) as T;
}

function stableUlid(namespace: string): string {
  const timestamp = BigInt(Date.parse(SEED_AS_OF));
  const entropy = BigInt(
    `0x${createHash("sha256").update(namespace).digest("hex").slice(0, 20)}`,
  );
  let value = (timestamp << 80n) | entropy;
  let encoded = "";
  for (let index = 0; index < 26; index += 1) {
    encoded = ULID_ALPHABET[Number(value & 31n)] + encoded;
    value >>= 5n;
  }
  return encoded;
}

function fixtureFeature(
  key: string,
  value: Feature["value"] = null,
  unit?: string,
): Feature {
  return { key, value, ...(unit ? { unit } : {}) };
}

const flightAttributes = (): Feature[] => [
  fixtureFeature("flight.mobility_device.accepted"),
  fixtureFeature(
    "flight.mobility_device.battery_capacity_limit_wh",
    null,
    "Wh",
  ),
  fixtureFeature("flight.mobility_device.lithium_ion_battery_accepted"),
  fixtureFeature("flight.mobility_device.manual_wheelchair_stowage"),
  fixtureFeature("flight.boarding.step_free"),
];

const transferAttributes = (): Feature[] => [
  fixtureFeature("transfer.vehicle.wheelchair_compatible"),
  fixtureFeature("transfer.vehicle.ramp_or_lift"),
];

const hotelAttributes = (): Feature[] => [
  fixtureFeature("hotel.room.step_free_route"),
  fixtureFeature("hotel.room.roll_in_shower"),
];

const TRIP_SPECS: SeedTripSpec[] = [
  {
    key: "electric-wheelchair-london",
    title: "Amsterdam to London · powered mobility",
    starts_at: "2027-03-15T08:00:00.000Z",
    ends_at: "2027-03-18T10:00:00.000Z",
    assets: [
      {
        key: "flight",
        kind: "flight",
        provider: "TEST AIR",
        provider_reference: "TEST-AIR-TA103-20270315",
        starts_at: "2027-03-15T08:00:00.000Z",
        ends_at: "2027-03-15T10:35:00.000Z",
        attributes: flightAttributes(),
      },
      {
        key: "transfer",
        kind: "ground_transfer",
        provider: "TEST Step-Free Cars",
        provider_reference: "TEST-TRANSFER-LHR-20270315",
        starts_at: "2027-03-15T11:15:00.000Z",
        ends_at: "2027-03-15T12:00:00.000Z",
        attributes: transferAttributes(),
      },
      {
        key: "hotel",
        kind: "hotel_room",
        provider: "TEST Riverside Hotel",
        provider_reference: "TEST-HOTEL-LON-20270315",
        starts_at: "2027-03-15T15:00:00.000Z",
        ends_at: "2027-03-18T10:00:00.000Z",
        attributes: hotelAttributes(),
      },
    ],
    constraints: [
      {
        key: "battery-capacity",
        traveler_text:
          "My electric wheelchair has a removable 300 Wh lithium-ion battery. The operating airline must confirm an accepted battery limit of at least 300 Wh.",
        asset_key: "flight",
        predicate: {
          feature: "flight.mobility_device.battery_capacity_limit_wh",
          operator: "gte",
          value: 300,
          unit: "Wh",
        },
      },
      {
        key: "lithium-ion-battery",
        traveler_text:
          "The operating airline must confirm that removable lithium-ion wheelchair batteries are accepted and handled safely.",
        asset_key: "flight",
        predicate: {
          feature: "flight.mobility_device.lithium_ion_battery_accepted",
          operator: "eq",
          value: true,
        },
      },
      {
        key: "step-free-boarding",
        traveler_text:
          "I need step-free boarding and a step-free route between the gate and aircraft seat.",
        asset_key: "flight",
        predicate: {
          feature: "flight.boarding.step_free",
          operator: "eq",
          value: true,
        },
      },
      {
        key: "manual-chair-stowage",
        traveler_text:
          "My folding manual backup wheelchair must be securely stowed for the flight without being treated as ordinary checked baggage.",
        asset_key: "flight",
        predicate: {
          feature: "flight.mobility_device.manual_wheelchair_stowage",
          operator: "eq",
          value: true,
        },
      },
      {
        key: "accessible-ground-transfer",
        traveler_text:
          "The pre-booked airport transfer must be wheelchair-compatible and have a ramp or lift.",
        asset_key: "transfer",
        predicate: {
          feature: "transfer.vehicle.ramp_or_lift",
          operator: "eq",
          value: true,
        },
      },
      {
        key: "step-free-hotel-route",
        traveler_text:
          "The hotel room must have a step-free route from the entrance and lift to the room.",
        asset_key: "hotel",
        predicate: {
          feature: "hotel.room.step_free_route",
          operator: "eq",
          value: true,
        },
      },
    ],
  },
  {
    key: "manual-wheelchair-copenhagen",
    title: "Amsterdam to Copenhagen · manual chair access",
    starts_at: "2027-05-04T10:30:00.000Z",
    ends_at: "2027-05-07T10:00:00.000Z",
    assets: [
      {
        key: "flight",
        kind: "flight",
        provider: "TEST AIR",
        provider_reference: "TEST-AIR-TA208-20270504",
        starts_at: "2027-05-04T10:30:00.000Z",
        ends_at: "2027-05-04T12:00:00.000Z",
        attributes: flightAttributes(),
      },
      {
        key: "transfer",
        kind: "ground_transfer",
        provider: "TEST Accessible Vans",
        provider_reference: "TEST-TRANSFER-CPH-20270504",
        starts_at: "2027-05-04T12:30:00.000Z",
        ends_at: "2027-05-04T13:00:00.000Z",
        attributes: transferAttributes(),
      },
      {
        key: "hotel",
        kind: "hotel_room",
        provider: "TEST Canal Quarter Hotel",
        provider_reference: "TEST-HOTEL-CPH-20270504",
        starts_at: "2027-05-04T15:00:00.000Z",
        ends_at: "2027-05-07T10:00:00.000Z",
        attributes: hotelAttributes(),
      },
    ],
    constraints: [
      {
        key: "step-free-boarding",
        traveler_text:
          "Boarding must be step-free, including any transfer from the gate to the aircraft.",
        asset_key: "flight",
        predicate: {
          feature: "flight.boarding.step_free",
          operator: "eq",
          value: true,
        },
      },
      {
        key: "manual-chair-stowage",
        traveler_text:
          "The folding manual wheelchair must be stowed securely and returned at the aircraft door when possible.",
        asset_key: "flight",
        predicate: {
          feature: "flight.mobility_device.manual_wheelchair_stowage",
          operator: "eq",
          value: true,
        },
      },
      {
        key: "accessible-transfer",
        traveler_text:
          "The airport transfer must fit a wheelchair and support level boarding with a ramp or lift.",
        asset_key: "transfer",
        predicate: {
          feature: "transfer.vehicle.wheelchair_compatible",
          operator: "eq",
          value: true,
        },
      },
      {
        key: "step-free-hotel-route",
        traveler_text:
          "The hotel must confirm a step-free route to the booked room.",
        asset_key: "hotel",
        predicate: {
          feature: "hotel.room.step_free_route",
          operator: "eq",
          value: true,
        },
      },
    ],
  },
];

function buildContract(
  spec: SeedTripSpec,
  travelerId: string,
): AccessContractDocument {
  const tripId = stableUlid(`demo-seed/v${SEED_VERSION}/trip/${spec.key}`);
  const contractId = stableUlid(
    `demo-seed/v${SEED_VERSION}/contract/${spec.key}`,
  );
  const assets: AccessAsset[] = spec.assets.map((assetSpec) => ({
    asset_id: stableUlid(
      `demo-seed/v${SEED_VERSION}/${spec.key}/asset/${assetSpec.key}`,
    ),
    kind: assetSpec.kind,
    provider: assetSpec.provider,
    provider_reference: assetSpec.provider_reference,
    starts_at: assetSpec.starts_at,
    ends_at: assetSpec.ends_at,
    attributes: structuredClone(assetSpec.attributes),
  }));
  const assetIds = new Map(
    spec.assets.map((assetSpec, index) => [
      assetSpec.key,
      assets[index]!.asset_id,
    ]),
  );
  const evidence: AccessEvidence[] = assets.map((asset) => {
    const evidenceId = stableUlid(
      `demo-seed/v${SEED_VERSION}/${spec.key}/evidence/${asset.asset_id}`,
    );
    return {
      evidence_id: evidenceId,
      asset_id: asset.asset_id,
      source_type: "fixture",
      verification_level: "unverified",
      features: structuredClone(asset.attributes),
      source_uri: `https://demo.accesshold.test/${spec.key}/${evidenceId}`,
      content_sha256: createHash("sha256")
        .update(`AccessHold synthetic itinerary fixture ${evidenceId}`)
        .digest("hex"),
      observed_at: SEED_AS_OF,
      provenance: "fixture",
    };
  });
  const evidenceIds = new Map(
    evidence.map((item) => [item.asset_id, item.evidence_id]),
  );
  const constraints: AccessConstraint[] = spec.constraints.map(
    (constraintSpec) => {
      const assetId = assetIds.get(constraintSpec.asset_key);
      if (!assetId) throw new Error("demo_seed_constraint_asset_missing");
      const evidenceId = evidenceIds.get(assetId);
      if (!evidenceId) throw new Error("demo_seed_constraint_evidence_missing");
      return {
        constraint_id: stableUlid(
          `demo-seed/v${SEED_VERSION}/${spec.key}/constraint/${constraintSpec.key}`,
        ),
        traveler_text: constraintSpec.traveler_text,
        priority: "hard",
        applies_to: [assetId],
        predicate: structuredClone(constraintSpec.predicate),
        status: "unverified",
        evidence_ids: [evidenceId],
      };
    },
  );

  return {
    schema_version: 1,
    contract_id: contractId,
    traveler_id: travelerId,
    trip: {
      trip_id: tripId,
      title: spec.title,
      starts_at: spec.starts_at,
      ends_at: spec.ends_at,
      time_zone: "Europe/Amsterdam",
      source: "fixture",
    },
    assets,
    constraints,
    evidence,
    approval_policy: {
      allowed_actions: ["sandbox_rebook", "send_provider_request"],
      max_additional_cost: { amount_minor: 25000, currency: "EUR" },
      voice_approval_allowed: false,
      human_handoff_contact: "accessibility@example.test",
    },
    status: "degraded",
    provenance: "fixture",
    version: 1,
    created_at: SEED_AS_OF,
    updated_at: SEED_AS_OF,
  };
}

function assetAndEvidence(
  contract: AccessContractDocument,
  assetKind: AccessAsset["kind"],
): { asset: AccessAsset; evidence: AccessEvidence } {
  const asset = contract.assets.find((item) => item.kind === assetKind);
  if (!asset) throw new Error("demo_seed_scenario_asset_missing");
  const evidence = contract.evidence.find(
    (item) => item.asset_id === asset.asset_id,
  );
  if (!evidence) throw new Error("demo_seed_scenario_evidence_missing");
  return { asset, evidence };
}

function makeRebookingOption(input: {
  asset: AccessAsset;
  evidence: AccessEvidence;
  optionId: string;
  summary: string;
  reference: string;
  inventoryToken: string;
  amountMinor: number;
  terms: string;
  expiresAt: string;
  unknowns: string[];
}): PrecalculatedRebookingOption {
  return {
    option_id: input.optionId,
    summary: input.summary,
    action: "sandbox_rebook",
    asset_id: input.asset.asset_id,
    asset_version: 1,
    evidence_id: input.evidence.evidence_id,
    evidence_version: 1,
    replacement_provider_reference: input.reference,
    amount_minor: input.amountMinor,
    currency: "EUR",
    terms: input.terms,
    inventory_token: input.inventoryToken,
    expires_at: input.expiresAt,
    unknowns: input.unknowns,
    requires_traveler_approval: true,
    live_action: false,
  };
}

function buildScenarios(
  contracts: AccessContractDocument[],
): SeededDisruptionScenario[] {
  const london = contracts.find((item) => item.trip.title.includes("London"));
  const copenhagen = contracts.find((item) =>
    item.trip.title.includes("Copenhagen"),
  );
  if (!london || !copenhagen)
    throw new Error("demo_seed_scenario_contract_missing");

  const londonFlight = assetAndEvidence(london, "flight");
  const copenhagenFlight = assetAndEvidence(copenhagen, "flight");
  const londonConstraints = london.constraints.filter((item) =>
    item.applies_to.includes(londonFlight.asset.asset_id),
  );
  const copenhagenConstraints = copenhagen.constraints.filter((item) =>
    item.applies_to.includes(copenhagenFlight.asset.asset_id),
  );
  const delayExpiresAt = "2027-03-15T07:45:00.000Z";
  const gateExpiresAt = "2027-05-04T09:45:00.000Z";

  return [
    {
      scenario_id: stableUlid("demo-seed/v1/scenario/flight-delay"),
      case_id: stableUlid("demo-seed/v1/case/flight-delay"),
      trip_id: london.trip.trip_id,
      asset_id: londonFlight.asset.asset_id,
      constraint_ids: londonConstraints.map((item) => item.constraint_id),
      kind: "flight_delay",
      provenance: "fixture",
      generated_at: SEED_AS_OF,
      event: {
        detected_at: "2027-03-15T06:30:00.000Z",
        summary:
          "Simulated 95-minute departure delay on TEST AIR TA103, with a 90-minute arrival delay.",
        original: {
          departure_at: "2027-03-15T08:00:00.000Z",
          arrival_at: "2027-03-15T10:35:00.000Z",
          gate: "A12",
        },
        updated: {
          departure_at: "2027-03-15T09:35:00.000Z",
          arrival_at: "2027-03-15T12:05:00.000Z",
          gate: "A12",
        },
      },
      precalculated_options: [
        makeRebookingOption({
          ...londonFlight,
          optionId: "test-delay-next-nonstop",
          summary:
            "TEST AIR TA121 nonstop, estimated arrival at 12:45 local; current inventory is synthetic.",
          reference: "TEST-AIR-TA121-20270315",
          inventoryToken: "TEST-INVENTORY-TA121-20270315",
          amountMinor: 0,
          terms:
            "Synthetic option only. No reservation, payment, or provider request is submitted.",
          expiresAt: delayExpiresAt,
          unknowns: [
            "Replacement-aircraft boarding is not confirmed step-free.",
            "The 300 Wh lithium-ion battery limit and handling are not confirmed for the replacement flight.",
            "The airport transfer pickup time must be reconfirmed if this option is chosen.",
          ],
        }),
        makeRebookingOption({
          ...londonFlight,
          optionId: "test-delay-via-brussels",
          summary:
            "TEST AIR TA145 via Brussels, estimated arrival at 14:10 local; the connection is protected in the fixture.",
          reference: "TEST-AIR-TA145-20270315",
          inventoryToken: "TEST-INVENTORY-TA145-20270315",
          amountMinor: 4500,
          terms:
            "Synthetic option only. A 45 EUR fare difference is shown for review and has not been charged.",
          expiresAt: delayExpiresAt,
          unknowns: [
            "Both flight segments require written confirmation of step-free boarding.",
            "Battery acceptance and manual-chair stowage have not been verified on either aircraft.",
            "The transfer provider has not confirmed a revised arrival pickup.",
          ],
        }),
      ],
      no_action: {
        option_id: "no_action",
        summary:
          "Keep the booked flight for now and review the delay again before departure.",
        unknowns: [
          "The revised arrival time may affect the airport transfer and hotel arrival.",
          "No accessibility feature is treated as confirmed by this simulation.",
        ],
      },
    },
    {
      scenario_id: stableUlid("demo-seed/v1/scenario/gate-change"),
      case_id: stableUlid("demo-seed/v1/case/gate-change"),
      trip_id: copenhagen.trip.trip_id,
      asset_id: copenhagenFlight.asset.asset_id,
      constraint_ids: copenhagenConstraints.map((item) => item.constraint_id),
      kind: "gate_change",
      provenance: "fixture",
      generated_at: SEED_AS_OF,
      event: {
        detected_at: "2027-05-04T07:00:00.000Z",
        summary:
          "Simulated gate reassignment from A12 to D34; the published route to D34 has not been checked for step-free access.",
        original: {
          departure_at: "2027-05-04T10:30:00.000Z",
          arrival_at: "2027-05-04T12:00:00.000Z",
          gate: "A12",
        },
        updated: {
          departure_at: "2027-05-04T10:30:00.000Z",
          arrival_at: "2027-05-04T12:00:00.000Z",
          gate: "D34",
        },
      },
      precalculated_options: [
        makeRebookingOption({
          ...copenhagenFlight,
          optionId: "test-gate-change-alternate-flight",
          summary:
            "TEST AIR TA218 from gate B02, estimated arrival at 13:20 local; the alternate gate is a simulation detail only.",
          reference: "TEST-AIR-TA218-20270504",
          inventoryToken: "TEST-INVENTORY-TA218-20270504",
          amountMinor: 0,
          terms:
            "Synthetic option only. No reservation, payment, or provider request is submitted.",
          expiresAt: gateExpiresAt,
          unknowns: [
            "Step-free boarding is not independently confirmed for the replacement flight.",
            "Secure stowage and return of the manual wheelchair are not confirmed.",
            "The accessible transfer pickup time needs reconfirmation if the arrival changes.",
          ],
        }),
        {
          option_id: "prepare-step-free-gate-request",
          summary:
            "Keep the current booking and prepare a request for a step-free gate route and manual-wheelchair stowage confirmation.",
          action: "prepare_provider_request",
          asset_id: copenhagenFlight.asset.asset_id,
          asset_version: 1,
          evidence_id: copenhagenFlight.evidence.evidence_id,
          evidence_version: 1,
          provider_question:
            "Can you confirm a step-free route to gate D34, boarding assistance if needed, and the agreed stowage and return point for the folding manual wheelchair?",
          amount_minor: 0,
          currency: "EUR",
          terms:
            "Draft only. The traveler must review and approve any request; no message is sent by the seed utility.",
          expires_at: gateExpiresAt,
          unknowns: [
            "The airline has not confirmed the gate route or assistance availability.",
            "The provider response and stowage arrangements remain unknown.",
          ],
          requires_traveler_approval: true,
          live_action: false,
        },
      ],
      no_action: {
        option_id: "no_action",
        summary:
          "Keep the scheduled flight while checking whether gate D34 has a step-free route.",
        unknowns: [
          "Gate accessibility and manual-wheelchair handling are not confirmed.",
          "No provider request is sent and no booking is changed.",
        ],
      },
    },
  ];
}

export function createDemoTravelerSeedBundle(): DemoTravelerSeedBundle {
  const travelerId = stableUlid(`demo-seed/v${SEED_VERSION}/traveler`);
  const contracts = TRIP_SPECS.map((spec) => buildContract(spec, travelerId));
  return {
    seed_version: SEED_VERSION,
    generated_at: SEED_AS_OF,
    provenance: "fixture",
    traveler_id: travelerId,
    contracts,
    scenarios: buildScenarios(contracts),
  };
}

export async function validateDemoTravelerSeedBundle(
  bundle: DemoTravelerSeedBundle = createDemoTravelerSeedBundle(),
): Promise<void> {
  const schema = await readJson<object>("schemas/access-contract.schema.json");
  const featureRegistry = await readJson<FeatureRegistry>(
    "content/feature-registry/v1.json",
  );
  const knownFeatures = new Map(
    featureRegistry.features.map((feature) => [feature.key, feature]),
  );
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    allowUnionTypes: true,
  });
  addFormats(ajv);
  const validate = ajv.compile(schema);

  if (bundle.seed_version !== SEED_VERSION || bundle.provenance !== "fixture") {
    throw new Error("demo_seed_bundle_must_be_fixture_provenance");
  }
  for (const contract of bundle.contracts) {
    if (!validate(contract)) {
      throw new Error(
        `demo_seed_contract_schema_invalid:${JSON.stringify(validate.errors)}`,
      );
    }
    const semanticIssues = validateAccessContractSemantics(contract);
    if (semanticIssues.length > 0) {
      throw new Error(
        `demo_seed_contract_semantics_invalid:${semanticIssues.join(",")}`,
      );
    }
    for (const asset of contract.assets) {
      for (const feature of asset.attributes) {
        if (!knownFeatures.has(feature.key))
          throw new Error(`demo_seed_feature_unregistered:${feature.key}`);
      }
    }
    for (const item of contract.evidence) {
      for (const feature of item.features) {
        if (!knownFeatures.has(feature.key))
          throw new Error(`demo_seed_feature_unregistered:${feature.key}`);
      }
    }
    for (const constraint of contract.constraints) {
      const definition = knownFeatures.get(constraint.predicate.feature);
      if (!definition)
        throw new Error(
          `demo_seed_feature_unregistered:${constraint.predicate.feature}`,
        );
      if (
        constraint.predicate.unit &&
        !definition.allowed_units.includes(constraint.predicate.unit)
      ) {
        throw new Error(
          `demo_seed_feature_unit_unregistered:${constraint.predicate.feature}`,
        );
      }
    }
  }

  const contractsByTrip = new Map(
    bundle.contracts.map((contract) => [contract.trip.trip_id, contract]),
  );
  for (const scenario of bundle.scenarios) {
    const contract = contractsByTrip.get(scenario.trip_id);
    if (
      !contract ||
      contract.provenance !== "fixture" ||
      !contract.assets.some((asset) => asset.asset_id === scenario.asset_id) ||
      scenario.constraint_ids.some(
        (constraintId) =>
          !contract.constraints.some(
            (constraint) => constraint.constraint_id === constraintId,
          ),
      ) ||
      scenario.precalculated_options.length < 2
    ) {
      throw new Error("demo_seed_scenario_binding_invalid");
    }
    for (const option of scenario.precalculated_options) {
      if (
        option.asset_id !== scenario.asset_id ||
        option.requires_traveler_approval !== true ||
        option.live_action !== false ||
        option.amount_minor < 0 ||
        option.currency !== "EUR" ||
        Date.parse(option.expires_at) <= Date.parse(bundle.generated_at) ||
        option.unknowns.length === 0
      ) {
        throw new Error("demo_seed_recovery_option_invalid");
      }
      if (
        option.action === "sandbox_rebook" &&
        !option.replacement_provider_reference.startsWith("TEST-")
      ) {
        throw new Error("demo_seed_rebooking_must_use_test_inventory");
      }
      if (
        option.action === "prepare_provider_request" &&
        !option.provider_question.trim()
      ) {
        throw new Error("demo_seed_provider_question_missing");
      }
    }
  }
}

function sameSeedIdentity(
  current: AccessContractDocument | undefined,
  seed: AccessContractDocument,
): current is AccessContractDocument {
  return Boolean(
    current &&
      current.provenance === "fixture" &&
      current.contract_id === seed.contract_id &&
      current.traveler_id === seed.traveler_id &&
      current.trip.trip_id === seed.trip.trip_id,
  );
}

export async function seedTravelerContracts(
  repository: ContractRepository,
  bundle: DemoTravelerSeedBundle = createDemoTravelerSeedBundle(),
): Promise<TravelerSeedRepositoryResult> {
  const insertedTripIds: string[] = [];
  const existingTripIds: string[] = [];

  for (const contract of bundle.contracts) {
    const existing = await repository.current(contract.trip.trip_id);
    if (existing) {
      if (!sameSeedIdentity(existing, contract)) {
        throw new Error("demo_seed_trip_id_collision");
      }
      existingTripIds.push(contract.trip.trip_id);
      continue;
    }

    try {
      await repository.append(contract, null);
      insertedTripIds.push(contract.trip.trip_id);
    } catch (error) {
      const raced = await repository.current(contract.trip.trip_id);
      if (!sameSeedIdentity(raced, contract)) throw error;
      existingTripIds.push(contract.trip.trip_id);
    }
  }

  return {
    inserted_trip_ids: insertedTripIds,
    existing_trip_ids: existingTripIds,
  };
}

interface CliOptions {
  driver: ContractRepositoryDriver | "both" | null;
  scenariosOutputPath: string | null;
  dryRun: boolean;
  help: boolean;
}

function parseCliOptions(args: string[], env: NodeJS.ProcessEnv): CliOptions {
  let driver: CliOptions["driver"] =
    env.CONTRACT_REPOSITORY_DRIVER === "postgres" ||
    env.CONTRACT_REPOSITORY_DRIVER === "dynamodb"
      ? env.CONTRACT_REPOSITORY_DRIVER
      : null;
  let scenariosOutputPath = env.DEMO_SEED_SCENARIOS_PATH ?? null;
  let dryRun = false;
  let help = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") {
      continue;
    }
    if (argument === "--driver") {
      const value = args[index + 1];
      if (value !== "postgres" && value !== "dynamodb" && value !== "both") {
        throw new Error("seed_driver_must_be_postgres_dynamodb_or_both");
      }
      driver = value;
      index += 1;
    } else if (argument === "--scenarios-output") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("seed_scenarios_output_path_required");
      }
      scenariosOutputPath = value;
      index += 1;
    } else if (argument === "--dry-run") {
      dryRun = true;
    } else if (argument === "--help" || argument === "-h") {
      help = true;
    } else {
      throw new Error(`unknown_seed_argument:${argument}`);
    }
  }

  return { driver, scenariosOutputPath, dryRun, help };
}

function usage(): string {
  return [
    "Usage: pnpm seed:traveler-data -- [--driver postgres|dynamodb|both] [--scenarios-output <file>] [--dry-run]",
    "Set DATABASE_URL (or DATABASE_HOST/DATABASE_NAME/DATABASE_CREDENTIALS) for PostgreSQL and WORKFLOW_TABLE_NAME plus AWS credentials/region for DynamoDB.",
    "The command writes synthetic fixture contracts only; scenario JSON is printed to stdout and can also be saved with --scenarios-output.",
  ].join("\n");
}

export async function runSeedTravelerData(
  args: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const options = parseCliOptions(args, env);
  if (options.help) {
    console.log(usage());
    return;
  }

  const bundle = createDemoTravelerSeedBundle();
  await validateDemoTravelerSeedBundle(bundle);
  const results: Array<{
    driver: ContractRepositoryDriver | "dry-run";
    inserted_trip_ids: string[];
    existing_trip_ids: string[];
  }> = [];

  if (options.dryRun) {
    results.push({
      driver: "dry-run",
      inserted_trip_ids: [],
      existing_trip_ids: bundle.contracts.map((item) => item.trip.trip_id),
    });
  } else {
    if (!options.driver) {
      throw new Error(
        "seed_driver_required_use_CONTRACT_REPOSITORY_DRIVER_or_--driver",
      );
    }
    const drivers: ContractRepositoryDriver[] =
      options.driver === "both" ? ["postgres", "dynamodb"] : [options.driver];

    for (const driver of drivers) {
      const driverEnvironment: NodeJS.ProcessEnv = {
        ...env,
        CONTRACT_REPOSITORY_DRIVER: driver,
      };
      const handle = ContractRepositoryFactory.create(
        driver,
        driverEnvironment,
      );
      try {
        const result = await seedTravelerContracts(handle.repository, bundle);
        results.push({ driver, ...result });
      } finally {
        await handle.close();
      }
    }
  }

  const report = {
    seed_version: bundle.seed_version,
    generated_at: bundle.generated_at,
    provenance: bundle.provenance,
    traveler_id: bundle.traveler_id,
    results,
    contracts: bundle.contracts,
    scenarios: bundle.scenarios,
  };
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (options.scenariosOutputPath) {
    const outputPath = resolve(options.scenariosOutputPath);
    const scenarioBundle = `${JSON.stringify(
      {
        seed_version: bundle.seed_version,
        generated_at: bundle.generated_at,
        provenance: bundle.provenance,
        traveler_id: bundle.traveler_id,
        scenarios: bundle.scenarios,
      },
      null,
      2,
    )}\n`;
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, scenarioBundle, {
      encoding: "utf8",
      mode: 0o600,
    });
  }
  console.log(serialized);
}

function isMainModule(): boolean {
  return Boolean(
    process.argv[1] &&
      fileURLToPath(import.meta.url) === resolve(process.argv[1]),
  );
}

if (isMainModule()) {
  runSeedTravelerData().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "unknown_error";
    console.error(`Traveler demo seed failed: ${message}`);
    process.exitCode = 1;
  });
}
