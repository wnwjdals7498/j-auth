#!/bin/sh
set -eu

: "${KEYCLOAK_DB_PASSWORD:?KEYCLOAK_DB_PASSWORD is required}"
: "${JAUTH_DB_PASSWORD:?JAUTH_DB_PASSWORD is required}"

psql --no-psqlrc --set=ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
\getenv keycloak_password KEYCLOAK_DB_PASSWORD
\getenv jauth_password JAUTH_DB_PASSWORD

SELECT format('CREATE ROLE keycloak LOGIN PASSWORD %L', :'keycloak_password')
\gexec
SELECT format('CREATE ROLE jauth LOGIN PASSWORD %L', :'jauth_password')
\gexec

CREATE DATABASE keycloak OWNER keycloak;
CREATE DATABASE jauth OWNER jauth;

SELECT format('REVOKE CONNECT, TEMPORARY ON DATABASE %I FROM PUBLIC', datname)
FROM pg_database
WHERE datallowconn
\gexec

GRANT CONNECT, TEMPORARY ON DATABASE keycloak TO keycloak;
GRANT CONNECT, TEMPORARY ON DATABASE jauth TO jauth;
REVOKE CONNECT, TEMPORARY ON DATABASE keycloak FROM jauth;
REVOKE CONNECT, TEMPORARY ON DATABASE jauth FROM keycloak;
SQL
