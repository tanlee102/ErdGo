CREATE TABLE tenants (
    id   INT PRIMARY KEY,
    name TEXT NOT NULL
);

CREATE TABLE accounts (
    id         INT PRIMARY KEY,
    tenant_id  INT NOT NULL REFERENCES tenants(id)
        ON DELETE CASCADE
        ON UPDATE RESTRICT,
    email      TEXT NOT NULL,
    deleted_at TIMESTAMP
);

CREATE UNIQUE INDEX ux_accounts_active_email
    ON accounts(tenant_id, email)
    WHERE deleted_at IS NULL;

CREATE TABLE account_events (
    id         INT PRIMARY KEY,
    account_id INT NOT NULL REFERENCES accounts(id)
        ON DELETE CASCADE
        DEFERRABLE INITIALLY DEFERRED
);
