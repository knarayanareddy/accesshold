import schema from "../../../schemas/access-contract.schema.json" with { type: "json" };
import example from "../../../examples/access-contract.example.json" with { type: "json" };
import change from "../../../content/demo/hotel-change-v1.json" with { type: "json" };
import registry from "../../../content/feature-registry/v1.json" with { type: "json" };
import templates from "../../../content/provider-questions/v1.json" with { type: "json" };
import type {
  AccessContractDocument,
  ProviderQuestionTemplateSet,
} from "../../../packages/contracts/src/index.js";
import type { FeatureRegistry } from "../../../packages/policy-engine/src/index.js";
import type { ReferenceTravelChange } from "../../../packages/adapters/reference-travel/src/index.js";
import { FixtureProviderQuestionAdapter } from "../../../packages/adapters/ses/src/fixture-provider-question-adapter.js";
import { InMemoryContractRepository } from "../../importer/src/in-memory-contract-repository.js";
import type { ContractRepository } from "../../importer/src/contract-repository.js";
import { ManualContractService } from "../../importer/src/manual-contract-service.js";
import { ProviderQuestionService } from "../../importer/src/provider-question-service.js";
import { FixtureTripArtifactDeletionAdapter } from "../../importer/src/fixture-trip-artifact-deletion-adapter.js";
import { TripDeletionService } from "../../importer/src/trip-deletion-core.js";
import { ReferenceTravelMonitor } from "../../monitor/src/reference-travel-monitor.js";
import { FixtureReferenceTravelAdapter } from "../../../packages/adapters/reference-travel/src/index.js";
import {
  FixtureRecoveryService,
  type FixtureRecoveryOption,
} from "../../recovery/src/fixture-recovery-service.js";
import { FixtureHandoffService } from "../../workflow/src/fixture-workflow-service.js";
import type { AccessHoldMcpServices } from "../../mcp/src/accesshold-mcp-server.js";

export interface FixtureRuntime extends AccessHoldMcpServices {
  repository: ContractRepository;
  contracts: ManualContractService;
  providerQuestions: ProviderQuestionService;
  deletion: TripDeletionService;
  monitor: ReferenceTravelMonitor;
  recovery: FixtureRecoveryService;
  handoff: FixtureHandoffService;
  actorTravelerId: string;
  demoTripId: string;
  demoCaseId: string;
  demoOptionId: string;
  demoClock: () => Date;
}

/** Creates one deterministic local journey from the checked-in synthetic contract. */
export async function createFixtureRuntime(): Promise<FixtureRuntime> {
  const fixtureSchema = schema as object;
  const fixtureRegistry = registry as FeatureRegistry;
  const fixtureExample = example as AccessContractDocument;
  const fixtureChange = change as ReferenceTravelChange;
  const fixtureTemplates = templates as ProviderQuestionTemplateSet;
  const demoClock = () => new Date("2026-10-24T10:00:00.000Z");
  const repository = new InMemoryContractRepository();
  await repository.append(fixtureExample, null);
  const contracts = new ManualContractService(
    fixtureSchema,
    fixtureRegistry,
    repository,
    demoClock,
  );
  const providerQuestions = new ProviderQuestionService(
    contracts,
    new FixtureProviderQuestionAdapter(demoClock),
    fixtureTemplates,
    demoClock,
  );
  const deletion = new TripDeletionService(
    contracts,
    repository,
    [new FixtureTripArtifactDeletionAdapter()],
    demoClock,
  );
  const monitor = new ReferenceTravelMonitor(
    fixtureSchema,
    fixtureRegistry,
    repository,
    new FixtureReferenceTravelAdapter([fixtureChange]),
    demoClock,
  );
  const changeResult = await monitor.ingest(
    fixtureChange,
    fixtureExample.traveler_id,
  );
  const recovery = new FixtureRecoveryService(demoClock, [
    changeResult.affected_asset,
  ]);
  const handoff = new FixtureHandoffService(demoClock);
  const recoveryOption: FixtureRecoveryOption = {
    option_id: "test-room-replacement",
    summary:
      "TEST PROVIDER replacement room option; the new room's shower configuration remains unconfirmed.",
    action: "sandbox_rebook",
    asset_id: fixtureChange.asset_id,
    asset_version: changeResult.affected_asset.asset_version,
    evidence_id: changeResult.affected_asset.evidence_id,
    evidence_version: changeResult.affected_asset.evidence_version,
    replacement_provider_reference: "TEST-ROOM-REPLACEMENT-001",
    amount_minor: 0,
    currency: "EUR",
    terms:
      "Fixture only. No reservation, payment, or provider request is submitted.",
    inventory_token: "TEST-INVENTORY-ROOM-001",
    expires_at: new Date(demoClock().getTime() + 5 * 60_000).toISOString(),
    unknowns: [
      "The replacement room's shower configuration has not been independently confirmed.",
    ],
  };
  const cases = await monitor.cases(
    fixtureExample.trip.trip_id,
    fixtureExample.traveler_id,
  );
  const recoveryCase = cases.find(
    (item) => item.case_id === changeResult.recovery_case?.case_id,
  );
  if (!recoveryCase) throw new Error("fixture_recovery_case_not_created");
  const optionsByCase = new Map<string, FixtureRecoveryOption[]>([
    [recoveryCase.case_id, [recoveryOption]],
  ]);
  const findCase: AccessHoldMcpServices["findCase"] = async ({
    caseId,
    actorTravelerId,
  }) => {
    for (const document of await repository.listCurrent()) {
      if (document.traveler_id !== actorTravelerId) continue;
      const tripCases = await monitor.cases(
        document.trip.trip_id,
        actorTravelerId,
      );
      const foundCase = tripCases.find((item) => item.case_id === caseId);
      if (foundCase) return { document, recoveryCase: foundCase };
    }
    throw new Error("recovery_case_not_found");
  };
  const findEvidence: AccessHoldMcpServices["findEvidence"] = async ({
    evidenceId,
    actorTravelerId,
  }) => {
    for (const document of await repository.listCurrent()) {
      if (document.traveler_id !== actorTravelerId) continue;
      const evidence = document.evidence.find(
        (item) => item.evidence_id === evidenceId,
      );
      if (evidence) return { document, evidence };
    }
    throw new Error("evidence_not_found");
  };

  return {
    repository,
    contracts,
    providerQuestions,
    deletion,
    monitor,
    recovery,
    handoff,
    registry: fixtureRegistry,
    actorTravelerId: fixtureExample.traveler_id,
    demoTripId: fixtureExample.trip.trip_id,
    demoCaseId: recoveryCase.case_id,
    demoOptionId: recoveryOption.option_id,
    demoClock,
    clock: demoClock,
    listRecoveryOptions: async ({ caseId, tripId, actorTravelerId }) => {
      const found = await findCase({ caseId, actorTravelerId });
      if (found.document.trip.trip_id !== tripId)
        throw new Error("recovery_case_trip_mismatch");
      return structuredClone(optionsByCase.get(caseId) ?? []);
    },
    findCase,
    findEvidence,
  };
}
