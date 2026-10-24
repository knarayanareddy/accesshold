-- Aurora PostgreSQL contract history, matching PostgresContractRepository.
-- Apply through the controlled migration step before enabling API/worker traffic.
CREATE TABLE IF NOT EXISTS accesshold_contract_versions (
  trip_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  contract_id text NOT NULL,
  traveler_id text NOT NULL,
  document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (trip_id, version),
  UNIQUE (contract_id, version),
  CHECK (document->'trip'->>'trip_id' = trip_id),
  CHECK ((document->>'version')::integer = version),
  CHECK (document->>'traveler_id' = traveler_id)
);

CREATE INDEX IF NOT EXISTS accesshold_contract_versions_traveler_version_idx
  ON accesshold_contract_versions (traveler_id, trip_id, version DESC);
