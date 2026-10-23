import type {
  AccessConstraint,
  AccessContractDocument,
  AccessEvidence,
  Feature,
  Predicate,
  SourceType,
} from "../../contracts/src/index.js";

export type PredicateStatus =
  | "satisfied"
  | "violated"
  | "unknown"
  | "not_applicable";
export type ContractStatus = "active" | "degraded" | "violated";

export interface FeatureDefinition {
  key: string;
  value_type: "boolean" | "number";
  allowed_units: string[];
  canonical_unit: string | null;
  allowed_sources: SourceType[];
  stale_after_hours: number;
}

export interface FeatureRegistry {
  version: string;
  review_status: string;
  features: FeatureDefinition[];
}

export interface PredicateEvaluation {
  status: PredicateStatus;
  code: string;
}

export interface ConstraintEvaluation extends PredicateEvaluation {
  constraint_id: string;
  priority: "hard" | "preference";
}

export interface ContractEvaluation {
  status: ContractStatus;
  policy_version: string;
  provenance: "live" | "fixture";
  constraints: ConstraintEvaluation[];
  notice: string;
}

function unknown(code: string): PredicateEvaluation {
  return { status: "unknown", code };
}

function convertNumber(
  value: number,
  fromUnit: string | undefined,
  toUnit: string | null,
): number | null {
  if (!Number.isFinite(value)) return null;
  if (toUnit === null) return fromUnit === undefined ? value : null;
  const from = fromUnit ?? toUnit;
  if (from === toUnit) return value;
  if (from === "in" && toUnit === "cm") return value * 2.54;
  if (from === "cm" && toUnit === "in") return value / 2.54;
  return null;
}

export function evaluatePredicate(
  predicate: Predicate,
  feature: Feature | undefined,
  definition: FeatureDefinition | undefined,
): PredicateEvaluation {
  if (!definition || definition.key !== predicate.feature)
    return unknown("unregistered_feature");
  if (!feature || feature.key !== predicate.feature || feature.value === null)
    return unknown("feature_unknown");

  let actual: string | number | boolean = feature.value;
  let expected: Predicate["value"] = predicate.value;

  if (definition.value_type === "number") {
    if (typeof actual !== "number") return unknown("feature_type_mismatch");
    if (
      !definition.allowed_units.includes(
        feature.unit ?? definition.canonical_unit ?? "",
      )
    ) {
      return unknown("feature_unit_not_allowed");
    }
    if (predicate.unit && !definition.allowed_units.includes(predicate.unit)) {
      return unknown("predicate_unit_not_allowed");
    }
    const normalizedActual = convertNumber(
      actual,
      feature.unit,
      definition.canonical_unit,
    );
    if (normalizedActual === null) return unknown("unit_conversion_failed");
    actual = normalizedActual;

    if (typeof expected === "number") {
      const normalizedExpected = convertNumber(
        expected,
        predicate.unit,
        definition.canonical_unit,
      );
      if (normalizedExpected === null) return unknown("unit_conversion_failed");
      expected = normalizedExpected;
    } else if (
      Array.isArray(expected) &&
      expected.every((item) => typeof item === "number")
    ) {
      const converted = expected.map((item) =>
        convertNumber(item, predicate.unit, definition.canonical_unit),
      );
      if (converted.some((item) => item === null))
        return unknown("unit_conversion_failed");
      expected = converted as number[];
    }
  } else if (typeof actual !== "boolean") {
    return unknown("feature_type_mismatch");
  }

  switch (predicate.operator) {
    case "exists":
      if (typeof expected !== "boolean")
        return unknown("invalid_predicate_value");
      return {
        status: expected ? "satisfied" : "violated",
        code: "existence_evaluated",
      };
    case "eq":
      return {
        status: actual === expected ? "satisfied" : "violated",
        code: "equality_evaluated",
      };
    case "neq":
      return {
        status: actual !== expected ? "satisfied" : "violated",
        code: "inequality_evaluated",
      };
    case "gte":
    case "lte": {
      if (typeof actual !== "number" || typeof expected !== "number")
        return unknown("invalid_numeric_predicate");
      const satisfied =
        predicate.operator === "gte" ? actual >= expected : actual <= expected;
      return {
        status: satisfied ? "satisfied" : "violated",
        code: "threshold_evaluated",
      };
    }
    case "in": {
      if (!Array.isArray(expected))
        return unknown("invalid_membership_predicate");
      return {
        status: expected.includes(actual) ? "satisfied" : "violated",
        code: "membership_evaluated",
      };
    }
  }
}

function isExpired(
  evidence: AccessEvidence,
  definition: FeatureDefinition,
  nowMs: number,
): boolean {
  const observedMs = Date.parse(evidence.observed_at);
  if (!Number.isFinite(observedMs)) return true;
  const registryExpiry = observedMs + definition.stale_after_hours * 3_600_000;
  const explicitExpiry = evidence.expires_at
    ? Date.parse(evidence.expires_at)
    : Number.POSITIVE_INFINITY;
  return nowMs >= Math.min(registryExpiry, explicitExpiry);
}

function evaluateEvidence(
  predicate: Predicate,
  evidence: AccessEvidence,
  feature: Feature | undefined,
  definition: FeatureDefinition | undefined,
  nowMs: number,
  allowFixture: boolean,
): PredicateEvaluation {
  if (!definition) return unknown("unregistered_feature");
  if (evidence.source_type === "fixture") {
    if (!allowFixture || evidence.provenance !== "fixture")
      return unknown("fixture_not_allowed");
  } else if (!definition.allowed_sources.includes(evidence.source_type)) {
    return unknown("source_not_allowed");
  }
  if (evidence.provenance === "fixture" && !allowFixture)
    return unknown("fixture_not_allowed");
  if (isExpired(evidence, definition, nowMs)) return unknown("evidence_stale");
  return evaluatePredicate(predicate, feature, definition);
}

function aggregateEvidence(
  evaluations: PredicateEvaluation[],
): PredicateEvaluation {
  if (evaluations.length === 0) return unknown("evidence_missing");
  const hasSatisfied = evaluations.some((item) => item.status === "satisfied");
  const hasViolated = evaluations.some((item) => item.status === "violated");
  if (hasSatisfied && hasViolated) return unknown("conflicting_evidence");
  if (hasViolated) return { status: "violated", code: "evidence_violated" };
  if (
    hasSatisfied &&
    evaluations.every((item) => item.status === "satisfied")
  ) {
    return { status: "satisfied", code: "evidence_satisfied" };
  }
  return (
    evaluations.find((item) => item.status === "unknown") ??
    unknown("evidence_inconclusive")
  );
}

function evaluateConstraint(
  constraint: AccessConstraint,
  document: AccessContractDocument,
  registry: Map<string, FeatureDefinition>,
  nowMs: number,
  allowFixture: boolean,
): ConstraintEvaluation {
  const base = {
    constraint_id: constraint.constraint_id,
    priority: constraint.priority,
  };
  if (constraint.status === "not_applicable")
    return {
      ...base,
      status: "not_applicable",
      code: "explicitly_not_applicable",
    };

  const definition = registry.get(constraint.predicate.feature);
  const assetResults = constraint.applies_to.map((assetId) => {
    const relevantEvidence = document.evidence.filter(
      (item) =>
        constraint.evidence_ids.includes(item.evidence_id) &&
        item.asset_id === assetId,
    );
    const evaluations = relevantEvidence.map((evidence) =>
      evaluateEvidence(
        constraint.predicate,
        evidence,
        evidence.features.find(
          (feature) => feature.key === constraint.predicate.feature,
        ),
        definition,
        nowMs,
        allowFixture,
      ),
    );
    return aggregateEvidence(evaluations);
  });

  if (assetResults.some((item) => item.status === "violated")) {
    return { ...base, status: "violated", code: "hard_feature_violated" };
  }
  if (assetResults.some((item) => item.status === "unknown")) {
    const result =
      assetResults.find((item) => item.status === "unknown") ??
      unknown("feature_unknown");
    return { ...base, ...result };
  }
  if (
    assetResults.length > 0 &&
    assetResults.every((item) => item.status === "satisfied")
  ) {
    return {
      ...base,
      status: "satisfied",
      code: "all_applicable_assets_satisfied",
    };
  }
  return { ...base, status: "unknown", code: "no_applicable_assets" };
}

export function aggregateHardConstraintStatus(
  results: ConstraintEvaluation[],
): ContractStatus {
  const hard = results.filter((item) => item.priority === "hard");
  if (hard.length === 0) return "degraded";
  if (hard.some((item) => item.status === "violated")) return "violated";
  if (hard.some((item) => item.status === "unknown")) return "degraded";
  return "active";
}

export function evaluateAccessContract(input: {
  document: AccessContractDocument;
  registry: FeatureRegistry;
  now: Date;
  allowFixture?: boolean;
}): ContractEvaluation {
  const nowMs = input.now.getTime();
  if (!Number.isFinite(nowMs))
    throw new Error("A valid evaluation time is required");
  const allowFixture =
    input.allowFixture === true && input.document.provenance === "fixture";
  const registry = new Map(
    input.registry.features.map((definition) => [definition.key, definition]),
  );
  const constraints = input.document.constraints.map((constraint) =>
    evaluateConstraint(
      constraint,
      input.document,
      registry,
      nowMs,
      allowFixture,
    ),
  );
  return {
    status: aggregateHardConstraintStatus(constraints),
    policy_version: input.registry.version,
    provenance: input.document.provenance,
    constraints,
    notice:
      "Workflow evidence state only; this is not a guarantee of physical accessibility.",
  };
}
