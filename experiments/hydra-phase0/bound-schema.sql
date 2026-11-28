-- Apply with the Hydra migration role before starting the bound Worker.
CREATE TABLE IF NOT EXISTS mapi_hydra_grant (
    grant_id text PRIMARY KEY,
    session_id text NOT NULL
);

CREATE TABLE IF NOT EXISTS mapi_hydra_mint (
    attempt_id text PRIMARY KEY,
    grant_id text NOT NULL REFERENCES mapi_hydra_grant(grant_id),
    outcome text NOT NULL CHECK (outcome IN ('committed', 'cancelled'))
);

-- Old spike grants have no identity row and cannot pass a bound live check.
CREATE TABLE IF NOT EXISTS mapi_hydra_identity (
    grant_id text PRIMARY KEY REFERENCES mapi_hydra_grant(grant_id),
    project_id text NOT NULL,
    user_id text NOT NULL,
    session_id text NOT NULL,
    issuer text NOT NULL
);
