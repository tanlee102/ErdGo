-- SQLite .dump style export with PRAGMAs, inserts, sqlite_sequence noise, and composite keys.
PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;

CREATE TABLE "customers" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "email" TEXT NOT NULL UNIQUE,
    "plan" TEXT NOT NULL DEFAULT 'free',
    "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "customers_plan_check" CHECK ("plan" IN ('free', 'team', 'enterprise'))
);

CREATE TABLE "invoices" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "customer_id" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "issued_at" TEXT,
    "paid_at" TEXT,
    FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE
);

CREATE TABLE "invoice_lines" (
    "invoice_id" INTEGER NOT NULL,
    "line_no" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "amount_cents" INTEGER NOT NULL CHECK ("amount_cents" >= 0),
    PRIMARY KEY ("invoice_id", "line_no"),
    FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE
);

CREATE INDEX "index_invoices_on_customer_status" ON "invoices" ("customer_id", "status");
CREATE INDEX "index_invoice_lines_on_description" ON "invoice_lines" ("description");
INSERT INTO "sqlite_sequence" VALUES('customers', 1);
COMMIT;
