/** Canonical multi-dialect examples rendered by the SQL syntax documentation page. */
export const erdSemanticResolutionExample = `CREATE TYPE app.ticket_status AS ENUM ('new', 'open', 'closed');

CREATE TABLE app.accounts (
  tenant_id  INT NOT NULL,
  account_no TEXT NOT NULL,
  status     app.ticket_status NOT NULL DEFAULT 'new',
  PRIMARY KEY (tenant_id, account_no)
);

CREATE TABLE app.contacts (
  tenant_id   INT NOT NULL,
  account_no  TEXT NOT NULL,
  owner_email TEXT,
  CONSTRAINT fk_contacts_account
    FOREIGN KEY (tenant_id, account_no)
    REFERENCES app.accounts
    ON DELETE CASCADE
    DEFERRABLE INITIALLY DEFERRED
);

ALTER TABLE app.contacts ADD COLUMN audit_state TEXT;
ALTER TABLE app.contacts ALTER COLUMN owner_email TYPE VARCHAR(320);
ALTER TABLE app.contacts ALTER COLUMN owner_email SET NOT NULL;
ALTER TABLE app.contacts RENAME COLUMN owner_email TO contact_email;
ALTER TABLE app.contacts DROP COLUMN audit_state;

CREATE UNIQUE INDEX ux_contacts_email
  ON app.contacts (contact_email);`;

export const mysqlAlterReplayExample = `CREATE TABLE \`customers\` (
  \`id\` BIGINT AUTO_INCREMENT PRIMARY KEY,
  \`email\` VARCHAR(320) NOT NULL,
  UNIQUE INDEX \`ux_customers_email\` (\`email\`)
) ENGINE=InnoDB;

CREATE TABLE \`orders\` (
  \`id\` BIGINT AUTO_INCREMENT PRIMARY KEY,
  \`customer_email\` VARCHAR(320),
  \`status\` ENUM('new','paid') NOT NULL DEFAULT 'new',
  \`old_note\` VARCHAR(50),
  CONSTRAINT \`fk_orders_customer\`
    FOREIGN KEY (\`customer_email\`)
    REFERENCES \`customers\`(\`email\`)
    ON DELETE SET NULL
) ENGINE=InnoDB;

ALTER TABLE \`orders\`
  CHANGE COLUMN \`old_note\` \`note\` VARCHAR(255) NOT NULL;
ALTER TABLE \`orders\`
  MODIFY COLUMN \`status\` ENUM('new','paid') NOT NULL DEFAULT 'paid';`;

export const mssqlAlterReplayExample = `CREATE TABLE [dbo].[Customers] (
  [CustomerID] INT IDENTITY(1,1) NOT NULL,
  [Email] NVARCHAR(320) NOT NULL,
  CONSTRAINT [PK_Customers] PRIMARY KEY CLUSTERED ([CustomerID]),
  CONSTRAINT [UQ_Customers_Email] UNIQUE NONCLUSTERED ([Email])
);

CREATE TABLE [dbo].[Orders] (
  [OrderID] INT IDENTITY(1,1) NOT NULL,
  [CustomerEmail] NVARCHAR(320),
  [LegacyNote] NVARCHAR(50),
  CONSTRAINT [PK_Orders] PRIMARY KEY NONCLUSTERED ([OrderID]),
  CONSTRAINT [FK_Orders_Customers]
    FOREIGN KEY ([CustomerEmail])
    REFERENCES [dbo].[Customers]([Email])
    ON DELETE SET NULL
);

ALTER TABLE [dbo].[Orders]
  ALTER COLUMN [LegacyNote] NVARCHAR(255) NOT NULL;
ALTER TABLE [dbo].[Orders]
  ADD [CreatedAt] DATETIME2 NOT NULL DEFAULT '2026-01-01';`;

export const sqliteAlterReplayExample = `CREATE TABLE authors (
  id    INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE
) STRICT;

CREATE TABLE posts (
  author_id INTEGER NOT NULL
    REFERENCES authors(id) ON DELETE CASCADE ON UPDATE RESTRICT,
  post_id   TEXT NOT NULL,
  body      TEXT,
  PRIMARY KEY (author_id, post_id)
) STRICT, WITHOUT ROWID;

ALTER TABLE posts ADD COLUMN summary TEXT;
ALTER TABLE posts RENAME COLUMN summary TO excerpt;
ALTER TABLE authors RENAME TO writers;`;

export const partialUniqueIndexExample = `CREATE TABLE users (
  id         INT PRIMARY KEY,
  email      TEXT NOT NULL,
  deleted_at TIMESTAMP
);

CREATE UNIQUE INDEX ux_users_active_email
  ON users (email)
  WHERE deleted_at IS NULL;

CREATE TABLE login_events (
  id      INT PRIMARY KEY,
  user_id INT REFERENCES users(id) ON DELETE CASCADE
);`;

export const docsProductionSyntaxExamples = [
    erdSemanticResolutionExample,
    mysqlAlterReplayExample,
    mssqlAlterReplayExample,
    sqliteAlterReplayExample,
    partialUniqueIndexExample,
];
