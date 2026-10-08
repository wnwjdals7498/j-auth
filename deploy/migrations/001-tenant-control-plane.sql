CREATE TABLE tenants (
  tenant_id text PRIMARY KEY CHECK (tenant_id ~ '^[a-z][a-z0-9-]{2,30}$' AND tenant_id <> 'operator'),
  realm_name text NOT NULL UNIQUE CHECK (realm_name = 'tenant-' || tenant_id),
  status text NOT NULL DEFAULT 'creating' CHECK (status IN ('creating', 'active', 'failed')),
  service_key_hash text CHECK (service_key_hash ~ '^[a-f0-9]{64}$'),
  previous_service_key_hash text CHECK (previous_service_key_hash ~ '^[a-f0-9]{64}$'),
  previous_key_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'active' OR service_key_hash IS NOT NULL),
  CHECK ((previous_service_key_hash IS NULL) = (previous_key_expires_at IS NULL))
);

CREATE TABLE tenant_clients (
  tenant_id text NOT NULL REFERENCES tenants (tenant_id) ON DELETE CASCADE,
  client_id text NOT NULL CHECK (length(client_id) BETWEEN 1 AND 128),
  keycloak_id text NOT NULL CHECK (length(keycloak_id) BETWEEN 1 AND 128),
  PRIMARY KEY (tenant_id, client_id),
  UNIQUE (tenant_id, keycloak_id)
);

CREATE TABLE tenant_client_roles (
  tenant_id text NOT NULL,
  client_id text NOT NULL,
  role_name text NOT NULL CHECK (length(role_name) BETWEEN 1 AND 128),
  keycloak_id text NOT NULL CHECK (length(keycloak_id) BETWEEN 1 AND 128),
  PRIMARY KEY (tenant_id, client_id, role_name),
  UNIQUE (tenant_id, keycloak_id),
  FOREIGN KEY (tenant_id, client_id) REFERENCES tenant_clients (tenant_id, client_id) ON DELETE CASCADE
);

REVOKE ALL ON tenants, tenant_clients, tenant_client_roles FROM PUBLIC;
