ALTER TABLE tenants ADD COLUMN provisioning_id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE tenants ADD COLUMN bootstrap_username text
  CHECK (bootstrap_username IS NULL OR length(bootstrap_username) BETWEEN 1 AND 255);
