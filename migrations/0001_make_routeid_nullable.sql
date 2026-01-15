-- Make routeId nullable in territories table
ALTER TABLE territories ALTER COLUMN route_id DROP NOT NULL;
