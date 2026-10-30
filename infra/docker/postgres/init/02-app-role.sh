#!/bin/sh
# Creates the runtime role the API connects as (docs/phase-3-design.md §1).
# The container superuser (POSTGRES_USER) is the schema owner and runs migrations;
# the app role owns nothing and cannot bypass row-level security.
#
# Runs automatically on a fresh volume. To run it by hand (CI, or an existing volume):
#   PGHOST=localhost PGPASSWORD=... POSTGRES_USER=... DATABASE_USER=... DATABASE_PASSWORD=... \
#     sh infra/docker/postgres/init/02-app-role.sh
set -eu

: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${DATABASE_USER:?DATABASE_USER is required}"
: "${DATABASE_PASSWORD:?DATABASE_PASSWORD is required}"

# Migrations grant privileges to this exact role name.
if [ "$DATABASE_USER" != "foodstack_app" ]; then
  echo "DATABASE_USER must be foodstack_app (got '$DATABASE_USER')" >&2
  exit 1
fi

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v app_user="$DATABASE_USER" -v app_password="$DATABASE_PASSWORD" \
  -v main_db="${POSTGRES_DB:-foodstack}" <<'SQL'
SELECT format(
  'CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT',
  :'app_user', :'app_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'app_user')\gexec

SELECT format('GRANT CONNECT ON DATABASE %I TO %I', datname, :'app_user')
FROM pg_database WHERE datname IN (:'main_db', 'foodstack_test')\gexec
SQL
