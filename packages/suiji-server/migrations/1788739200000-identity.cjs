exports.up = (pgm) => pgm.sql(`
CREATE TABLE server_identity (
 singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
 server_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid()
);
INSERT INTO server_identity DEFAULT VALUES;
CREATE TABLE owners (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 singleton boolean NOT NULL UNIQUE DEFAULT true CHECK (singleton),
 username text NOT NULL, password_hash text NOT NULL
);
CREATE TABLE sessions (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES owners(id),
 access_hash text NOT NULL UNIQUE, refresh_hash text NOT NULL UNIQUE,
 access_expires_at timestamptz NOT NULL, refresh_expires_at timestamptz NOT NULL,
 revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
`);
exports.down = false;
