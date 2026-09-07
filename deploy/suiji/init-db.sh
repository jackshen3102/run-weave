#!/bin/sh
set -eu
# psql variables quote the password as a literal; never print it or place it in argv.
api_password=$(cat /run/secrets/api_password)
export SUIJI_API_PASSWORD="$api_password"
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set=ON_ERROR_STOP=1 <<'SQL'
\getenv api_password SUIJI_API_PASSWORD
CREATE ROLE suiji_api LOGIN PASSWORD :'api_password';
GRANT CONNECT ON DATABASE suiji TO suiji_api;
GRANT USAGE ON SCHEMA public TO suiji_api;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO suiji_api;
SQL
