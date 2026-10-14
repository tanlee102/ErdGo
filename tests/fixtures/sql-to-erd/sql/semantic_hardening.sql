CREATE TYPE app.status AS ENUM ('draft', 'active');
CREATE TYPE audit.status AS ENUM ('queued', 'archived');

CREATE TABLE app.accounts (
    tenant_id INT NOT NULL,
    account_no TEXT NOT NULL,
    "a,b" INT NOT NULL,
    "c.d" INT NOT NULL,
    state app.status NOT NULL DEFAULT 'active',
    PRIMARY KEY (tenant_id, account_no),
    CONSTRAINT uq_accounts_quoted UNIQUE ("a,b", "c.d")
);

CREATE TABLE app.contacts (
    tenant_id INT NOT NULL,
    account_no TEXT NOT NULL,
    "a,b" INT NOT NULL,
    "c.d" INT NOT NULL,
    audit_state audit.status,
    CONSTRAINT fk_contacts_accounts
        FOREIGN KEY (tenant_id, account_no)
        REFERENCES app.accounts
        ON DELETE CASCADE
        DEFERRABLE INITIALLY DEFERRED,
    CONSTRAINT fk_contacts_quoted
        FOREIGN KEY ("a,b", "c.d")
        REFERENCES app.accounts("a,b", "c.d")
        ON UPDATE SET NULL
);

CREATE TABLE "tenant.users" (
    "id.part" INT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE
);

ALTER TABLE app.contacts ADD COLUMN owner_email TEXT;
ALTER TABLE app.contacts ALTER COLUMN owner_email TYPE VARCHAR(320);
ALTER TABLE app.contacts ALTER COLUMN owner_email SET NOT NULL;
ALTER TABLE app.contacts RENAME COLUMN owner_email TO contact_email;
ALTER TABLE app.contacts ADD COLUMN reviewer_ref INT REFERENCES "tenant.users"("id.part") ON DELETE SET NULL;
ALTER TABLE app.contacts DROP COLUMN audit_state;
ALTER TABLE app.accounts RENAME TO customer_accounts;
