-- The first-login tour is shown once per account (applied at runtime by WorkerStorage.applySchemaUpgrades)
ALTER TABLE users ADD COLUMN tour_done_at TEXT;
