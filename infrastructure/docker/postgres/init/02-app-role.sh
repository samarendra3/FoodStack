#!/usr/bin/env bash
# Runs once when the local volume is first created (after 01-test-database.sql).
#
# POSTGRES_USER (= DATABASE_MIGRATION_USER) owns the schema and runs migrations.
# APP_DB_USER (= DATABASE_USER) is the role the API connects as: it can read and write rows but
# is not a superuser and has no BYPASSRLS, so row-level security applies to it.
#
# Sourced by the postgres entrypoint, so it must not `exit` or change shell options.

: "${APP_DB_USER:?APP_DB_USER (DATABASE_USER) is required}"
: "${APP_DB_PASSWORD:?APP_DB_PASSWORD (DATABASE_PASSWORD) is required}"

if [ "$APP_DB_USER" = "$POSTGRES_USER" ]; then
  echo "DATABASE_USER must differ from DATABASE_MIGRATION_USER" >&2
  false
fi

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v app_user="$APP_DB_USER" -v app_password="$APP_DB_PASSWORD" <<'SQL'
SELECT format(
  'CREATE ROLE %I LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L',
  :'app_user', :'app_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'app_user')\gexec
SQL

for db in "$POSTGRES_DB" foodstack_test; do
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$db" \
    -v app_user="$APP_DB_USER" -v owner="$POSTGRES_USER" <<'SQL'
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), :'app_user')\gexec
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO :"app_user";
-- Tables, sequences and functions the owner creates later (via migrations) are usable by the app.
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner" IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"app_user";
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner" IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO :"app_user";
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner" IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO :"app_user";
SQL
done
