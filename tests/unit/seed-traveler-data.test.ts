import { describe, expect, it } from "vitest";
import {
  createDemoTravelerSeedBundle,
  seedTravelerContracts,
  validateDemoTravelerSeedBundle,
} from "../../scripts/seed-traveler-data.js";
import { InMemoryContractRepository } from "../../services/importer/src/contract-repository.js";

describe("synthetic traveler demo seed", () => {
  it("builds schema-valid itineraries and safe delay and gate-change scenarios", async () => {
    const bundle = createDemoTravelerSeedBundle();
    await expect(
      validateDemoTravelerSeedBundle(bundle),
    ).resolves.toBeUndefined();

    expect(bundle.provenance).toBe("fixture");
    expect(bundle.contracts).toHaveLength(2);
    expect(bundle.contracts.map((contract) => contract.assets.length)).toEqual([
      3, 3,
    ]);
    expect(
      bundle.contracts.every(
        (contract) =>
          contract.provenance === "fixture" &&
          contract.status === "degraded" &&
          contract.constraints.every(
            (constraint) => constraint.status === "unverified",
          ),
      ),
    ).toBe(true);

    const features = bundle.contracts.flatMap((contract) =>
      contract.constraints.map((constraint) => constraint.predicate.feature),
    );
    expect(features).toContain(
      "flight.mobility_device.battery_capacity_limit_wh",
    );
    expect(features).toContain(
      "flight.mobility_device.lithium_ion_battery_accepted",
    );
    expect(features).toContain("flight.boarding.step_free");
    expect(features).toContain(
      "flight.mobility_device.manual_wheelchair_stowage",
    );

    const batteryConstraint = bundle.contracts
      .flatMap((contract) => contract.constraints)
      .find(
        (constraint) =>
          constraint.predicate.feature ===
          "flight.mobility_device.battery_capacity_limit_wh",
      );
    expect(batteryConstraint?.predicate).toMatchObject({
      operator: "gte",
      value: 300,
      unit: "Wh",
    });

    expect(bundle.scenarios.map((scenario) => scenario.kind)).toEqual([
      "flight_delay",
      "gate_change",
    ]);
    expect(
      bundle.scenarios.every(
        (scenario) =>
          scenario.provenance === "fixture" &&
          scenario.precalculated_options.length >= 2 &&
          scenario.precalculated_options.every(
            (option) =>
              option.requires_traveler_approval &&
              !option.live_action &&
              option.unknowns.length > 0,
          ),
      ),
    ).toBe(true);
    expect(
      bundle.scenarios
        .flatMap((scenario) => scenario.precalculated_options)
        .some((option) => option.action === "prepare_provider_request"),
    ).toBe(true);
  });

  it("seeds durable contract records idempotently without overwriting them", async () => {
    const bundle = createDemoTravelerSeedBundle();
    const repository = new InMemoryContractRepository();

    const first = await seedTravelerContracts(repository, bundle);
    expect(first.inserted_trip_ids).toHaveLength(2);
    expect(first.existing_trip_ids).toEqual([]);

    const storedBefore = await repository.listCurrentForTraveler(
      bundle.traveler_id,
    );
    const second = await seedTravelerContracts(repository, bundle);
    const storedAfter = await repository.listCurrentForTraveler(
      bundle.traveler_id,
    );

    expect(second.inserted_trip_ids).toEqual([]);
    expect(second.existing_trip_ids).toHaveLength(2);
    expect(storedAfter).toEqual(storedBefore);
  });
});
