-- Add conquest_metrics table to track bidirectional territory conquests
CREATE TABLE IF NOT EXISTS conquest_metrics (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  attacker_id VARCHAR NOT NULL REFERENCES "users"(id) ON DELETE CASCADE,
  defender_id VARCHAR NOT NULL REFERENCES "users"(id) ON DELETE CASCADE,
  area_stolen REAL NOT NULL,
  route_id VARCHAR REFERENCES "routes"(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Add indexes for quick lookups
CREATE INDEX IF NOT EXISTS conquest_metrics_attacker_idx ON conquest_metrics(attacker_id);
CREATE INDEX IF NOT EXISTS conquest_metrics_defender_idx ON conquest_metrics(defender_id);
CREATE INDEX IF NOT EXISTS conquest_metrics_route_idx ON conquest_metrics(route_id);
CREATE INDEX IF NOT EXISTS conquest_metrics_pair_idx ON conquest_metrics(attacker_id, defender_id);
