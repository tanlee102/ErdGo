/** Exercises complex schemas through the public SQL-to-ERD adapter. */
import { describe, expect, it } from 'vitest';
import { parseAST } from '@/lib/parse-ast/parseAst.js';
import { sqlToErdSchema } from '@/lib/erdJsonSchema.js';

const errorsOnly = (errors) => errors.filter((e) => e.severity === 'error');
const tableByName = (schema, name) => schema.tables.find((t) => t.name === name);
const colByName = (table, name) => table?.columns.find((c) => c.name === name);

function assertRenderable(schema) {
    expect(Array.isArray(schema.enums)).toBe(true);
    expect(Array.isArray(schema.composites)).toBe(true);
    expect(Array.isArray(schema.tables)).toBe(true);
    expect(Array.isArray(schema.relations)).toBe(true);
    schema.tables.forEach((table) => {
        expect(table.name).toBeTruthy();
        expect(Array.isArray(table.columns)).toBe(true);
        table.columns.forEach((column) => {
            expect(column.name).toBeTruthy();
            expect(typeof column.type).toBe('string');
            expect(Array.isArray(column.constraints)).toBe(true);
            expect(Array.isArray(column.extras)).toBe(true);
        });
    });
}

describe('SQL to ERD - complex production schemas', () => {
    it('converts schema-qualified types, composite keys, ALTER FKs, and indexes into a renderer-ready schema', () => {
        const sql = `
            CREATE TYPE tenant.order_status AS ENUM ('draft', 'paid', 'cancelled');
            CREATE TYPE tenant.money_amount AS (amount NUMERIC(12, 2), currency CHAR(3));

            CREATE TABLE tenant.accounts (
                tenant_id BIGINT NOT NULL,
                account_id BIGINT NOT NULL,
                code VARCHAR(32) NOT NULL,
                PRIMARY KEY (tenant_id, account_id),
                UNIQUE (tenant_id, code)
            );

            CREATE TABLE tenant.orders (
                tenant_id BIGINT NOT NULL,
                order_id BIGINT NOT NULL,
                account_id BIGINT NOT NULL,
                code VARCHAR(32) NOT NULL,
                status tenant.order_status NOT NULL DEFAULT 'draft',
                totals tenant.money_amount,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                PRIMARY KEY (tenant_id, order_id),
                CONSTRAINT uq_order_code UNIQUE (tenant_id, code)
            );

            ALTER TABLE tenant.orders
                ADD CONSTRAINT fk_orders_accounts
                FOREIGN KEY (tenant_id, account_id)
                REFERENCES tenant.accounts(tenant_id, account_id);

            CREATE INDEX idx_orders_status_created
                ON tenant.orders (status, created_at)
                WHERE status <> 'cancelled';

            CREATE UNIQUE INDEX uq_accounts_code_leaf
                ON tenant.accounts (tenant_id, code);
        `;

        const parsed = parseAST(sql);
        expect(errorsOnly(parsed.errors)).toEqual([]);
        expect(parsed.ast.indexes.map((idx) => idx.name).sort()).toEqual(['idx_orders_status_created', 'uq_accounts_code_leaf']);

        const schema = sqlToErdSchema(sql);
        assertRenderable(schema);
        expect(schema.enums).toEqual([{ name: 'order_status', values: ['draft', 'paid', 'cancelled'] }]);
        expect(schema.composites.map((type) => type.name)).toEqual(['money_amount']);
        expect(schema.tables.map((table) => table.name).sort()).toEqual(['accounts', 'orders']);

        const accounts = tableByName(schema, 'accounts');
        const orders = tableByName(schema, 'orders');
        expect(colByName(accounts, 'tenant_id').compositePk).toBe(true);
        expect(colByName(accounts, 'code').compositeUq).toBe(true);
        expect(colByName(orders, 'tenant_id').compositePk).toBe(true);
        expect(colByName(orders, 'status').type).toBe('order_status');
        expect(colByName(orders, 'status').extras).toContain("DEFAULT 'draft'");
        expect(colByName(orders, 'totals').type).toBe('money_amount');
        expect(colByName(orders, 'status').constraints).toContain('IDX');
        expect(colByName(orders, 'created_at').compositeIdx).toBe(true);

        const fkColumns = schema.relations
            .filter((rel) => rel.fkName === 'fk_orders_accounts')
            .map((rel) => `${rel.from.column}:${rel.to.column}`)
            .sort();
        expect(fkColumns).toEqual(['account_id:account_id', 'tenant_id:tenant_id']);
    });

    it('keeps valid relations while warning about an ALTER foreign key that targets an unknown column', () => {
        const sql = `
            CREATE TABLE parent (
                id INT PRIMARY KEY,
                code TEXT UNIQUE
            );
            CREATE TABLE child (
                id INT PRIMARY KEY,
                parent_id INT,
                bad_parent_id INT
            );
            ALTER TABLE child ADD CONSTRAINT fk_child_parent
                FOREIGN KEY (parent_id) REFERENCES parent(id);
            ALTER TABLE child ADD CONSTRAINT fk_child_bad_parent
                FOREIGN KEY (bad_parent_id) REFERENCES parent(does_not_exist);
        `;

        const schema = sqlToErdSchema(sql);
        expect(schema.relations).toHaveLength(1);
        expect(schema.relations[0].fkName).toBe('fk_child_parent');
        expect(schema._parseErrors.some((err) => err.kind === 'relation_dropped_unknown_column' && err.severity === 'warning')).toBe(true);
    });

    it('treats reserved words as column names when they are followed by real data types', () => {
        const sql = `
            CREATE TABLE metrics (
                key TEXT NOT NULL,
                index VARCHAR(20) NOT NULL,
                value NUMERIC DEFAULT 0,
                CONSTRAINT uq_metric_key_index UNIQUE (key, index)
            );
            CREATE INDEX idx_metrics_value ON metrics (value);
        `;

        const schema = sqlToErdSchema(sql);
        const metrics = tableByName(schema, 'metrics');
        expect(metrics.columns.map((column) => column.name)).toEqual(['key', 'index', 'value']);
        expect(colByName(metrics, 'key').compositeUq).toBe(true);
        expect(colByName(metrics, 'index').compositeUq).toBe(true);
        expect(colByName(metrics, 'value').constraints).toContain('IDX');
    });

    it('converts a ledger schema with user types, inline indexes, standalone indexes, and ALTER composite FKs', () => {
        const sql = `
            CREATE TYPE app.lifecycle AS ENUM ('draft', 'active', 'archived');
            CREATE TYPE app.money AS (amount NUMERIC(12, 2), currency CHAR(3));

            CREATE TABLE app.tenants (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                slug TEXT NOT NULL UNIQUE,
                state app.lifecycle NOT NULL DEFAULT 'active'
            );

            CREATE TABLE app.accounts (
                tenant_id BIGINT NOT NULL REFERENCES app.tenants(id),
                account_no TEXT NOT NULL,
                balance app.money,
                search_text TEXT,
                PRIMARY KEY (tenant_id, account_no),
                FULLTEXT KEY ft_accounts_search (search_text)
            );

            CREATE TABLE app.ledger_entries (
                tenant_id BIGINT NOT NULL,
                entry_no BIGINT NOT NULL,
                account_no TEXT NOT NULL,
                status app.lifecycle NOT NULL DEFAULT 'draft',
                posted_at TIMESTAMPTZ,
                metadata JSONB,
                PRIMARY KEY (tenant_id, entry_no),
                CONSTRAINT fk_entry_account
                    FOREIGN KEY (tenant_id, account_no)
                    REFERENCES app.accounts(tenant_id, account_no)
            );

            CREATE INDEX idx_entries_status_posted
                ON app.ledger_entries (status, posted_at DESC)
                WHERE status <> 'archived';

            CREATE TABLE app.ledger_lines (
                tenant_id BIGINT NOT NULL,
                entry_no BIGINT NOT NULL,
                line_no INT NOT NULL,
                amount NUMERIC NOT NULL,
                PRIMARY KEY (tenant_id, entry_no, line_no)
            );

            ALTER TABLE app.ledger_lines
                ADD CONSTRAINT fk_lines_entry
                FOREIGN KEY (tenant_id, entry_no)
                REFERENCES app.ledger_entries(tenant_id, entry_no);
        `;

        const parsed = parseAST(sql);
        expect(errorsOnly(parsed.errors)).toEqual([]);
        expect(parsed.ast.indexes.map((index) => index.name).sort()).toEqual([
            'ft_accounts_search',
            'idx_entries_status_posted',
        ]);

        const schema = sqlToErdSchema(sql);
        assertRenderable(schema);
        expect(schema.enums).toEqual([{ name: 'lifecycle', values: ['draft', 'active', 'archived'] }]);
        expect(schema.composites.map((type) => type.name)).toEqual(['money']);
        expect(schema.tables.map((table) => table.name).sort()).toEqual([
            'accounts',
            'ledger_entries',
            'ledger_lines',
            'tenants',
        ]);

        const tenants = tableByName(schema, 'tenants');
        const accounts = tableByName(schema, 'accounts');
        const entries = tableByName(schema, 'ledger_entries');
        const lines = tableByName(schema, 'ledger_lines');

        expect(colByName(tenants, 'state').type).toBe('lifecycle');
        expect(colByName(tenants, 'state').extras).toContain("DEFAULT 'active'");
        expect(colByName(accounts, 'balance').type).toBe('money');
        expect(colByName(accounts, 'search_text').constraints).toContain('IDX');
        expect(colByName(entries, 'status').constraints).toContain('IDX');
        expect(colByName(entries, 'posted_at').compositeIdx).toBe(true);
        expect(colByName(lines, 'tenant_id').compositePk).toBe(true);
        expect(colByName(lines, 'entry_no').fk).toBe(true);

        const relationKeys = schema.relations
            .map((relation) => `${relation.fkName || 'inline'}:${relation.from.table}.${relation.from.column}->${relation.to.table}.${relation.to.column}`)
            .sort();
        expect(relationKeys).toEqual([
            'fk_entry_account:ledger_entries.account_no->accounts.account_no',
            'fk_entry_account:ledger_entries.tenant_id->accounts.tenant_id',
            'fk_lines_entry:ledger_lines.entry_no->ledger_entries.entry_no',
            'fk_lines_entry:ledger_lines.tenant_id->ledger_entries.tenant_id',
            'inline:accounts.tenant_id->tenants.id',
        ]);
    });

    it('converts MSSQL banking syntax with GO batches, computed columns, filtered indexes, and bracketed identifiers', () => {
        const sql = `
            CREATE TABLE [dbo].[Branches] (
                [BranchID] INT IDENTITY(10, 5) NOT NULL,
                [Code] CHAR(6) NOT NULL,
                [Name] NVARCHAR(120) NOT NULL,
                CONSTRAINT [PK_Branches] PRIMARY KEY CLUSTERED ([BranchID]),
                CONSTRAINT [UQ_Branches_Code] UNIQUE NONCLUSTERED ([Code])
            );
            GO

            CREATE TABLE [dbo].[Customers] (
                [CustomerID] BIGINT IDENTITY(1000, 1) NOT NULL,
                [BranchID] INT NOT NULL,
                [Email] NVARCHAR(320),
                [FirstName] NVARCHAR(80) NOT NULL,
                [LastName] NVARCHAR(80) NOT NULL,
                [FullName] AS ([FirstName] + N' ' + [LastName]) PERSISTED NOT NULL,
                CONSTRAINT [PK_Customers] PRIMARY KEY CLUSTERED ([CustomerID]),
                CONSTRAINT [UQ_Customers_Email] UNIQUE NONCLUSTERED ([Email]),
                CONSTRAINT [FK_Customers_Branch]
                    FOREIGN KEY ([BranchID]) REFERENCES [dbo].[Branches]([BranchID])
            );
            GO

            CREATE TABLE [dbo].[Accounts] (
                [AccountID] BIGINT IDENTITY(5000, 10) NOT NULL,
                [CustomerID] BIGINT NOT NULL,
                [AccountNumber] NVARCHAR(34) NOT NULL,
                [Currency] CHAR(3) NOT NULL DEFAULT 'USD',
                [ClosedAt] DATETIME2 NULL,
                CONSTRAINT [PK_Accounts] PRIMARY KEY NONCLUSTERED ([AccountID]),
                CONSTRAINT [UQ_Accounts_Number] UNIQUE ([AccountNumber]),
                CONSTRAINT [FK_Accounts_Customer]
                    FOREIGN KEY ([CustomerID]) REFERENCES [dbo].[Customers]([CustomerID])
            );

            CREATE TABLE [dbo].[Ledger] (
                [EntryID] BIGINT IDENTITY(1, 1) NOT NULL,
                [AccountID] BIGINT NOT NULL,
                [PostedAt] DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
                [Amount] DECIMAL(19, 4) NOT NULL,
                [IsReversal] BIT NOT NULL DEFAULT 0,
                [AmountAbs] AS (ABS([Amount])) PERSISTED,
                CONSTRAINT [PK_Ledger] PRIMARY KEY CLUSTERED ([EntryID]),
                CONSTRAINT [FK_Ledger_Account]
                    FOREIGN KEY ([AccountID]) REFERENCES [dbo].[Accounts]([AccountID]),
                CONSTRAINT [CHK_Ledger_Amount] CHECK ([Amount] <> 0)
            );

            CREATE NONCLUSTERED INDEX [IX_Ledger_Account_Posted]
                ON [dbo].[Ledger] ([AccountID], [PostedAt] DESC)
                INCLUDE ([Amount])
                WHERE [IsReversal] = 0;
        `;

        const parsed = parseAST(sql);
        expect(errorsOnly(parsed.errors)).toEqual([]);

        const schema = sqlToErdSchema(sql);
        assertRenderable(schema);
        expect(schema.tables.map((table) => table.name).sort()).toEqual([
            'Accounts',
            'Branches',
            'Customers',
            'Ledger',
        ]);

        const branches = tableByName(schema, 'Branches');
        const customers = tableByName(schema, 'Customers');
        const accounts = tableByName(schema, 'Accounts');
        const ledger = tableByName(schema, 'Ledger');

        expect(colByName(branches, 'BranchID').pk).toBe(true);
        expect(colByName(branches, 'BranchID').autoIncrement).toBe(true);
        expect(colByName(branches, 'Code').constraints).toContain('UQ');
        expect(colByName(customers, 'FullName').type).toBe('COMPUTED');
        expect(colByName(customers, 'FullName').constraints).toContain('NN');
        expect(colByName(accounts, 'Currency').extras).toContain("DEFAULT 'USD'");
        expect(colByName(ledger, 'Amount').extras.some((extra) => extra.includes('CHK_Ledger_Amount'))).toBe(true);
        expect(colByName(ledger, 'AccountID').constraints).toContain('IDX');
        expect(colByName(ledger, 'PostedAt').compositeIdx).toBe(true);

        expect(schema.relations.map((relation) => relation.fkName).sort()).toEqual([
            'FK_Accounts_Customer',
            'FK_Customers_Branch',
            'FK_Ledger_Account',
        ]);
    });

    it('converts MySQL inline ENUM/SET domains, generated columns, and mixed inline/standalone indexes', () => {
        const sql = `
            CREATE TABLE \`workspaces\` (
                \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
                \`slug\` VARCHAR(64) NOT NULL,
                \`status\` ENUM('trial', 'active', 'locked') NOT NULL DEFAULT 'trial',
                \`flags\` SET('billing', 'sso', 'audit') DEFAULT 'billing',
                \`created_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                \`updated_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                PRIMARY KEY (\`id\`),
                UNIQUE KEY \`uk_workspace_slug\` (\`slug\`),
                KEY \`idx_workspace_status_created\` (\`status\`, \`created_at\`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

            CREATE TABLE \`memberships\` (
                \`workspace_id\` BIGINT UNSIGNED NOT NULL,
                \`user_id\` BIGINT UNSIGNED NOT NULL,
                \`role\` ENUM('owner', 'admin', 'member', 'viewer') NOT NULL DEFAULT 'viewer',
                \`permissions\` SET('read', 'write', 'delete') NOT NULL DEFAULT 'read',
                PRIMARY KEY (\`workspace_id\`, \`user_id\`),
                CONSTRAINT \`fk_members_workspace\`
                    FOREIGN KEY (\`workspace_id\`) REFERENCES \`workspaces\` (\`id\`) ON DELETE CASCADE
            ) ENGINE=InnoDB;

            CREATE TABLE \`api_keys\` (
                \`workspace_id\` BIGINT UNSIGNED NOT NULL,
                \`key\` VARCHAR(128) NOT NULL,
                \`name\` VARCHAR(100) NOT NULL,
                \`name_lc\` VARCHAR(100) GENERATED ALWAYS AS (LOWER(\`name\`)) VIRTUAL,
                PRIMARY KEY (\`workspace_id\`, \`key\`),
                CONSTRAINT \`fk_keys_workspace\`
                    FOREIGN KEY (\`workspace_id\`) REFERENCES \`workspaces\` (\`id\`)
            ) ENGINE=InnoDB;

            CREATE UNIQUE INDEX \`uq_members_role\` ON \`memberships\` (\`workspace_id\`, \`role\`);
            CREATE FULLTEXT INDEX \`ft_keys_name\` ON \`api_keys\` (\`name\`);
        `;

        const parsed = parseAST(sql);
        expect(errorsOnly(parsed.errors)).toEqual([]);
        expect(parsed.ast.indexes.map((index) => index.name).sort()).toEqual([
            'ft_keys_name',
            'idx_workspace_status_created',
            'uq_members_role',
        ]);

        const schema = sqlToErdSchema(sql);
        assertRenderable(schema);
        expect(schema.enums.map((item) => `${item.name}:${item.values.join('|')}`).sort()).toEqual([
            'flags_set:billing|sso|audit',
            'permissions_set:read|write|delete',
            'role_enum:owner|admin|member|viewer',
            'status_enum:trial|active|locked',
        ]);

        const workspaces = tableByName(schema, 'workspaces');
        const memberships = tableByName(schema, 'memberships');
        const apiKeys = tableByName(schema, 'api_keys');

        expect(colByName(workspaces, 'id').autoIncrement).toBe(true);
        expect(colByName(workspaces, 'status').type).toBe('status_enum');
        expect(colByName(workspaces, 'flags').type).toBe('flags_set');
        expect(colByName(workspaces, 'status').constraints).toContain('IDX');
        expect(colByName(workspaces, 'created_at').compositeIdx).toBe(true);
        expect(colByName(memberships, 'role').constraints).toContain('UQ');
        expect(colByName(memberships, 'role').compositeUq).toBe(true);
        expect(colByName(apiKeys, 'key').pk).toBe(true);
        expect(colByName(apiKeys, 'name_lc').extras.some((extra) => /GENERATED ALWAYS AS/i.test(extra))).toBe(true);
        expect(colByName(apiKeys, 'name').constraints).toContain('IDX');

        expect(schema.relations.map((relation) => `${relation.fkName}:${relation.from.table}.${relation.from.column}->${relation.to.table}.${relation.to.column}`).sort()).toEqual([
            'fk_keys_workspace:api_keys.workspace_id->workspaces.id',
            'fk_members_workspace:memberships.workspace_id->workspaces.id',
        ]);
    });

    it('normalizes mixed-case schema-qualified user-defined types and relation endpoints for renderer lookup', () => {
        const sql = `
            CREATE TYPE Catalog.ItemState AS ENUM ('draft', 'live', 'retired');
            CREATE TYPE Catalog.MoneyAmount AS (amount NUMERIC(12, 2), currency CHAR(3));

            CREATE TABLE Catalog.Products (
                ProductID INT PRIMARY KEY,
                State catalog.ITEMSTATE NOT NULL DEFAULT 'draft',
                Price CATALOG.MONEYAMOUNT
            );

            CREATE TABLE Catalog.ProductEvents (
                EventID INT PRIMARY KEY,
                ProductID INT NOT NULL REFERENCES catalog.products(productid),
                EventState CATALOG.itemstate NOT NULL DEFAULT 'live'
            );
        `;

        const schema = sqlToErdSchema(sql);
        assertRenderable(schema);
        expect(schema.enums).toEqual([{ name: 'ItemState', values: ['draft', 'live', 'retired'] }]);
        expect(schema.composites.map((type) => type.name)).toEqual(['MoneyAmount']);

        const products = tableByName(schema, 'Products');
        const events = tableByName(schema, 'ProductEvents');
        expect(colByName(products, 'State').type).toBe('ItemState');
        expect(colByName(products, 'Price').type).toBe('MoneyAmount');
        expect(colByName(events, 'EventState').type).toBe('ItemState');

        expect(schema.relations).toHaveLength(1);
        expect(schema.relations[0]).toMatchObject({
            from: { table: 'ProductEvents', column: 'ProductID' },
            to: { table: 'Products', column: 'ProductID' },
        });
        expect(schema._parseErrors.filter((error) => error.severity === 'warning')).toEqual([]);
    });

    it('converts SQLite app schema with STRICT tables, WITHOUT ROWID junctions, generated columns, and partial indexes', () => {
        const sql = `
            CREATE TABLE accounts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email TEXT NOT NULL UNIQUE,
                status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            ) STRICT;

            CREATE TABLE notebooks (
                account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
                notebook_id TEXT NOT NULL,
                title TEXT NOT NULL COLLATE NOCASE,
                normalized_title TEXT GENERATED ALWAYS AS (lower(title)) STORED,
                PRIMARY KEY (account_id, notebook_id),
                CHECK (length(title) > 0)
            ) STRICT, WITHOUT ROWID;

            CREATE TABLE notes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                account_id INTEGER NOT NULL,
                notebook_id TEXT NOT NULL,
                body TEXT,
                is_archived INTEGER NOT NULL DEFAULT 0 CHECK (is_archived IN (0, 1)),
                FOREIGN KEY (account_id, notebook_id)
                    REFERENCES notebooks(account_id, notebook_id)
                    ON UPDATE CASCADE ON DELETE CASCADE
            ) STRICT;

            CREATE INDEX idx_notes_active_notebook
                ON notes (account_id, notebook_id)
                WHERE is_archived = 0;
            CREATE INDEX idx_notes_body ON notes (body);
        `;

        const parsed = parseAST(sql);
        expect(errorsOnly(parsed.errors)).toEqual([]);

        const schema = sqlToErdSchema(sql);
        assertRenderable(schema);
        expect(schema.tables.map((table) => table.name).sort()).toEqual([
            'accounts',
            'notebooks',
            'notes',
        ]);

        const accounts = tableByName(schema, 'accounts');
        const notebooks = tableByName(schema, 'notebooks');
        const notes = tableByName(schema, 'notes');

        expect(colByName(accounts, 'id').autoIncrement).toBe(true);
        expect(colByName(accounts, 'status').extras.some((extra) => extra.includes('CHECK') && extra.includes("'active'"))).toBe(true);
        expect(colByName(notebooks, 'account_id').compositePk).toBe(true);
        expect(colByName(notebooks, 'normalized_title').extras.some((extra) => /GENERATED ALWAYS AS/i.test(extra))).toBe(true);
        expect(colByName(notes, 'account_id').constraints).toContain('IDX');
        expect(colByName(notes, 'notebook_id').compositeIdx).toBe(true);
        expect(colByName(notes, 'body').constraints).toContain('IDX');

        expect(schema.relations.map((relation) => `${relation.from.table}.${relation.from.column}->${relation.to.table}.${relation.to.column}`).sort()).toEqual([
            'notebooks.account_id->accounts.id',
            'notes.account_id->notebooks.account_id',
            'notes.notebook_id->notebooks.notebook_id',
        ]);
    });

    it('converts PostgreSQL warehouse schema with enum/composite types, generated columns, partition options, and expression indexes', () => {
        const sql = `
            CREATE TYPE wh.stock_state AS ENUM ('pending', 'available', 'reserved', 'scrapped');
            CREATE TYPE wh.measurement AS (
                value NUMERIC(12, 4),
                unit TEXT
            );

            CREATE TABLE wh.locations (
                tenant_id BIGINT NOT NULL,
                location_id BIGINT GENERATED ALWAYS AS IDENTITY,
                code TEXT NOT NULL,
                state wh.stock_state NOT NULL DEFAULT 'available',
                capacity wh.measurement,
                attrs JSONB NOT NULL DEFAULT jsonb_build_object('zone', 'default'),
                search_key TEXT GENERATED ALWAYS AS (lower(code)) STORED,
                PRIMARY KEY (tenant_id, location_id),
                CONSTRAINT uq_locations_code UNIQUE (tenant_id, code),
                CONSTRAINT chk_locations_state CHECK (state <> 'scrapped' OR attrs IS NOT NULL)
            ) PARTITION BY HASH (tenant_id);

            CREATE TABLE wh.inventory_lots (
                tenant_id BIGINT NOT NULL,
                lot_id BIGINT GENERATED BY DEFAULT AS IDENTITY,
                location_id BIGINT NOT NULL,
                sku TEXT NOT NULL,
                qty NUMERIC NOT NULL CHECK (qty >= 0),
                state wh.stock_state NOT NULL DEFAULT 'pending',
                PRIMARY KEY (tenant_id, lot_id),
                CONSTRAINT fk_lots_location
                    FOREIGN KEY (tenant_id, location_id)
                    REFERENCES wh.locations(tenant_id, location_id)
                    DEFERRABLE INITIALLY DEFERRED
            );

            CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_locations_state_code
                ON ONLY wh.locations USING btree (state, code)
                WHERE state <> 'scrapped';

            CREATE INDEX idx_lots_sku_expr
                ON wh.inventory_lots ((lower(sku)), state, qty DESC)
                WHERE qty > 0;
        `;

        const parsed = parseAST(sql);
        expect(errorsOnly(parsed.errors)).toEqual([]);
        expect(parsed.ast.indexes.map((index) => index.name).sort()).toEqual([
            'idx_locations_state_code',
            'idx_lots_sku_expr',
        ]);

        const schema = sqlToErdSchema(sql);
        assertRenderable(schema);
        expect(schema.enums).toEqual([{ name: 'stock_state', values: ['pending', 'available', 'reserved', 'scrapped'] }]);
        expect(schema.composites).toEqual([
            {
                name: 'measurement',
                fields: [
                    { name: 'value', type: 'NUMERIC(12, 4)' },
                    { name: 'unit', type: 'TEXT' },
                ],
            },
        ]);

        const locations = tableByName(schema, 'locations');
        const lots = tableByName(schema, 'inventory_lots');

        expect(colByName(locations, 'location_id').autoIncrement).toBe(true);
        expect(colByName(locations, 'state').type).toBe('stock_state');
        expect(colByName(locations, 'capacity').type).toBe('measurement');
        expect(colByName(locations, 'search_key').extras.some((extra) => /GENERATED ALWAYS AS/i.test(extra))).toBe(true);
        expect(colByName(locations, 'state').constraints).toContain('IDX');
        expect(colByName(locations, 'code').constraints).toContain('UQ');
        expect(colByName(locations, 'code').compositeIdx).toBeFalsy();
        expect(colByName(lots, 'lot_id').autoIncrement).toBe(true);
        expect(colByName(lots, 'state').constraints).toContain('IDX');
        expect(colByName(lots, 'qty').compositeIdx).toBe(true);
        expect(colByName(lots, 'qty').extras.some((extra) => extra.includes('CHECK'))).toBe(true);

        expect(schema.relations.map((relation) => `${relation.fkName}:${relation.from.column}->${relation.to.column}`).sort()).toEqual([
            'fk_lots_location:location_id->location_id',
            'fk_lots_location:tenant_id->tenant_id',
        ]);
    });
});
