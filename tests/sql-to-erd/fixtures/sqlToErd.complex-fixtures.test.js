/** Validates reusable complex SQL fixtures against targeted ERD assertions. */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseAST } from '@/lib/parse-ast/parseAst.js';
import { sqlToErdSchema } from '@/lib/erdJsonSchema.js';

const fixtureDir = new URL('../../fixtures/sql-to-erd/complex-sql/', import.meta.url);

const fixtures = [
    {
        fixture: 'mssql_healthcare_claims.sql',
        tables: ['Facilities', 'Patients', 'Encounters', 'Claims'],
        indexes: ['IX_Encounters_Status'],
        foreignNames: ['FK_Patients_Facility', 'FK_Encounters_Patient', 'FK_Encounters_Facility', 'FK_Claims_Encounter'],
        relations: [
            'FK_Patients_Facility:Patients.FacilityID->Facilities.FacilityID',
            'FK_Encounters_Patient:Encounters.PatientID->Patients.PatientID',
            'FK_Encounters_Facility:Encounters.FacilityID->Facilities.FacilityID',
            'FK_Claims_Encounter:Claims.EncounterID->Encounters.EncounterID',
        ],
        columns: [
            { table: 'Facilities', column: 'FacilityID', type: 'INT', constraints: ['PK'], flags: ['pk', 'autoIncrement'] },
            { table: 'Patients', column: 'FullName', type: 'COMPUTED', constraints: ['NN'], extras: ['FirstName', 'LastName', 'PERSISTED'] },
            { table: 'Patients', column: 'FacilityID', constraints: ['UQ', 'NN'], flags: ['fk', 'compositeUq'] },
            { table: 'Encounters', column: 'FacilityID', constraints: ['NN', 'IDX'], flags: ['fk', 'compositeIdx'] },
            { table: 'Claims', column: 'Balance', type: 'COMPUTED', extras: ['BilledAmount - PaidAmount'] },
        ],
    },
    {
        fixture: 'mssql_inventory_lots.sql',
        tables: ['Warehouses', 'Products', 'Lots', 'Movements'],
        indexes: ['IX_Movements_Lot_Reason'],
        foreignNames: ['FK_Lots_Warehouse', 'FK_Lots_Product', 'FK_Movements_Lot'],
        relations: [
            'FK_Lots_Warehouse:Lots.WarehouseID->Warehouses.WarehouseID',
            'FK_Lots_Product:Lots.ProductID->Products.ProductID',
            'FK_Movements_Lot:Movements.WarehouseID->Lots.WarehouseID',
            'FK_Movements_Lot:Movements.ProductID->Lots.ProductID',
            'FK_Movements_Lot:Movements.LotCode->Lots.LotCode',
        ],
        columns: [
            { table: 'Products', column: 'SearchName', type: 'COMPUTED', extras: ['LOWER(Name)', 'PERSISTED'] },
            { table: 'Lots', column: 'WarehouseID', constraints: ['PK'], flags: ['pk', 'fk', 'compositePk'] },
            { table: 'Lots', column: 'ProductID', constraints: ['PK'], flags: ['pk', 'fk', 'compositePk'] },
            { table: 'Movements', column: 'WarehouseID', constraints: ['NN', 'IDX'], flags: ['fk', 'compositeIdx'] },
            { table: 'Movements', column: 'Reason', constraints: ['NN', 'IDX'], extras: ["DEFAULT 'manual'"], flags: ['compositeIdx'] },
        ],
    },
    {
        fixture: 'mysql_collaboration_acl.sql',
        tables: ['workspaces_acl', 'projects_acl', 'project_members_acl', 'api_tokens_acl'],
        types: ['plan_enum', 'flags_set', 'visibility_enum', 'role_enum', 'permissions_set'],
        indexes: ['idx_projects_acl_visibility', 'idx_tokens_acl_label'],
        foreignNames: ['fk_projects_acl_workspace', 'fk_members_acl_project', 'fk_tokens_acl_workspace', 'fk_tokens_acl_project'],
        relations: [
            'fk_projects_acl_workspace:projects_acl.workspace_id->workspaces_acl.id',
            'fk_members_acl_project:project_members_acl.workspace_id->projects_acl.workspace_id',
            'fk_members_acl_project:project_members_acl.project_key->projects_acl.project_key',
            'fk_tokens_acl_workspace:api_tokens_acl.workspace_id->workspaces_acl.id',
            'fk_tokens_acl_project:api_tokens_acl.workspace_id->projects_acl.workspace_id',
            'fk_tokens_acl_project:api_tokens_acl.project_key->projects_acl.project_key',
        ],
        columns: [
            { table: 'workspaces_acl', column: 'plan', type: 'plan_enum', constraints: ['NN'], extras: ["DEFAULT 'free'"] },
            { table: 'projects_acl', column: 'name_key', constraints: ['IDX'], extras: ['GENERATED ALWAYS AS', 'LOWER(name)', 'STORED'], flags: ['compositeIdx'] },
            { table: 'projects_acl', column: 'visibility', type: 'visibility_enum', constraints: ['NN', 'IDX'], flags: ['compositeIdx'] },
            { table: 'project_members_acl', column: 'permissions', type: 'permissions_set', constraints: ['NN'], extras: ["DEFAULT 'read'"] },
            { table: 'api_tokens_acl', column: 'project_key', flags: ['fk'] },
            { table: 'api_tokens_acl', column: 'label_key', constraints: ['IDX'], extras: ['GENERATED ALWAYS AS', 'LOWER(label)', 'VIRTUAL'] },
        ],
    },
    {
        fixture: 'mysql_marketplace_orders.sql',
        tables: ['shops', 'products', 'orders', 'order_items'],
        types: ['status_enum', 'features_set', 'state_enum'],
        indexes: ['idx_shops_status_created', 'ft_products_search', 'idx_products_active_price', 'idx_items_sku_qty'],
        foreignNames: ['fk_products_shop', 'fk_orders_shop', 'fk_items_order', 'fk_items_product'],
        relations: [
            'fk_products_shop:products.shop_id->shops.id',
            'fk_orders_shop:orders.shop_id->shops.id',
            'fk_items_order:order_items.shop_id->orders.shop_id',
            'fk_items_order:order_items.order_id->orders.order_id',
            'fk_items_product:order_items.shop_id->products.shop_id',
            'fk_items_product:order_items.sku->products.sku',
        ],
        columns: [
            { table: 'shops', column: 'status', type: 'status_enum', constraints: ['NN', 'IDX'], flags: ['compositeIdx'] },
            { table: 'products', column: 'search_blob', constraints: ['IDX'] },
            { table: 'products', column: 'gross_price', extras: ['GENERATED ALWAYS AS', 'price * tax_rate', 'STORED'] },
            { table: 'orders', column: 'order_id', constraints: ['PK'], flags: ['pk', 'autoIncrement', 'compositePk'] },
            { table: 'order_items', column: 'sku', constraints: ['NN', 'IDX'], flags: ['fk', 'compositeIdx'] },
            { table: 'order_items', column: 'line_total', extras: ['GENERATED ALWAYS AS', 'qty * unit_price', 'VIRTUAL'] },
        ],
    },
    {
        fixture: 'postgres_finance_books.sql',
        tables: ['books', 'accounts', 'journal_entries', 'postings'],
        types: ['entry_side', 'posting_state', 'account_ref'],
        indexes: ['idx_entries_state_external', 'idx_postings_account_side'],
        foreignNames: ['fk_accounts_book', 'fk_entries_book', 'fk_postings_entry', 'fk_postings_account'],
        relations: [
            'fk_accounts_book:accounts.tenant_id->books.tenant_id',
            'fk_accounts_book:accounts.book_id->books.book_id',
            'fk_entries_book:journal_entries.tenant_id->books.tenant_id',
            'fk_entries_book:journal_entries.book_id->books.book_id',
            'fk_postings_entry:postings.tenant_id->journal_entries.tenant_id',
            'fk_postings_entry:postings.book_id->journal_entries.book_id',
            'fk_postings_entry:postings.entry_id->journal_entries.entry_id',
            'fk_postings_account:postings.tenant_id->accounts.tenant_id',
            'fk_postings_account:postings.book_id->accounts.book_id',
            'fk_postings_account:postings.account_id->accounts.account_id',
        ],
        columns: [
            { table: 'books', column: 'state', type: 'posting_state', constraints: ['NN'], extras: ["DEFAULT 'draft'"] },
            { table: 'accounts', column: 'account', type: 'account_ref' },
            { table: 'journal_entries', column: 'state', type: 'posting_state', constraints: ['NN', 'IDX'], flags: ['compositeIdx'] },
            { table: 'postings', column: 'account_id', constraints: ['NN', 'IDX'], flags: ['fk', 'compositeIdx'] },
            { table: 'postings', column: 'side', type: 'entry_side', constraints: ['NN', 'IDX'], flags: ['compositeIdx'] },
            { table: 'postings', column: 'amount', constraints: ['NN'], extras: ['CHECK (amount >= 0)'] },
        ],
    },
    {
        fixture: 'postgres_saas_audit.sql',
        tables: ['organizations', 'users', 'audit_events'],
        types: ['org_status', 'audit_action', 'money_amount'],
        indexes: ['idx_users_role_status', 'idx_audit_subject_action'],
        foreignNames: ['fk_audit_user'],
        relations: [
            'users.org_id->organizations.org_id',
            'fk_audit_user:audit_events.org_id->users.org_id',
            'fk_audit_user:audit_events.user_id->users.user_id',
        ],
        columns: [
            { table: 'organizations', column: 'status', type: 'org_status', constraints: ['NN'], extras: ["DEFAULT 'trial'", 'chk_org_status'] },
            { table: 'organizations', column: 'billing_limit', type: 'money_amount', extras: ['chk_org_status'] },
            { table: 'users', column: 'role', constraints: ['NN', 'IDX'], extras: ["DEFAULT 'member'"], flags: ['compositeIdx'] },
            { table: 'users', column: 'status', type: 'org_status', constraints: ['NN', 'IDX'], flags: ['compositeIdx'] },
            { table: 'audit_events', column: 'action', type: 'audit_action', constraints: ['NN', 'IDX'], flags: ['compositeIdx'] },
            { table: 'audit_events', column: 'payload', type: 'JSONB', constraints: ['NN'], extras: ['DEFAULT jsonb_build_object()'] },
        ],
    },
    {
        fixture: 'sqlite_content_graph.sql',
        tables: ['nodes', 'edges', 'tags', 'node_tags'],
        indexes: ['idx_nodes_kind_label', 'idx_edges_kind_weight'],
        relations: [
            'edges.from_node_id->nodes.id',
            'edges.to_node_id->nodes.id',
            'node_tags.node_id->nodes.id',
            'node_tags.tag_slug->tags.slug',
        ],
        columns: [
            { table: 'nodes', column: 'kind', constraints: ['NN', 'IDX'], extras: ['CHECK', 'page', 'folder'], flags: ['compositeIdx'] },
            { table: 'nodes', column: 'label_key', constraints: ['IDX'], extras: ['GENERATED ALWAYS AS', 'lower(label)', 'STORED'], flags: ['compositeIdx'] },
            { table: 'edges', column: 'from_node_id', constraints: ['PK'], flags: ['pk', 'fk', 'compositePk'] },
            { table: 'edges', column: 'weight', constraints: ['NN', 'IDX'], extras: ['DEFAULT 1', 'CHECK (weight >= 0)'], flags: ['compositeIdx'] },
            { table: 'node_tags', column: 'tag_slug', constraints: ['PK'], flags: ['pk', 'fk', 'compositePk'] },
        ],
    },
    {
        fixture: 'sqlite_offline_forms.sql',
        tables: ['devices', 'forms', 'form_versions', 'submissions'],
        indexes: ['idx_form_versions_published', 'idx_submissions_time'],
        relations: [
            'forms.device_id->devices.device_id',
            'form_versions.device_id->forms.device_id',
            'form_versions.form_id->forms.form_id',
            'submissions.device_id->form_versions.device_id',
            'submissions.form_id->form_versions.form_id',
            'submissions.version_no->form_versions.version_no',
        ],
        columns: [
            { table: 'devices', column: 'owner_email', constraints: ['UQ', 'NN'] },
            { table: 'forms', column: 'device_id', constraints: ['PK'], flags: ['pk', 'fk', 'compositePk'] },
            { table: 'forms', column: 'title_key', extras: ['GENERATED ALWAYS AS', 'lower(title)', 'STORED'] },
            { table: 'form_versions', column: 'is_published', constraints: ['NN', 'IDX'], extras: ['DEFAULT 0', 'CHECK (is_published IN(0, 1))'], flags: ['compositeIdx'] },
            { table: 'submissions', column: 'version_no', constraints: ['PK'], flags: ['pk', 'fk', 'compositePk'] },
            { table: 'submissions', column: 'submitted_at', constraints: ['NN', 'IDX'], extras: ['DEFAULT CURRENT_TIMESTAMP'] },
        ],
    },
];

function readFixture(fixture) {
    return readFileSync(new URL(fixture, fixtureDir), 'utf8');
}

function stripSchema(name) {
    if (!name) return name;
    const dot = name.lastIndexOf('.');
    return dot >= 0 ? name.slice(dot + 1) : name;
}

function astTableNames(parsed) {
    return parsed.ast.tables.map((table) => stripSchema(table.name));
}

function astTypeNames(parsed) {
    return parsed.ast.types.map((type) => stripSchema(type.name));
}

function astIndexNames(parsed) {
    return parsed.ast.indexes.map((index) => index.name);
}

function astForeignNames(parsed) {
    return parsed.ast.tables.flatMap((table) => table.constraints || [])
        .filter((constraint) => constraint.kind === 'foreign' && constraint.name)
        .map((constraint) => constraint.name);
}

function relationKeys(schema) {
    return schema.relations.map((relation) => {
        const prefix = relation.fkName ? `${relation.fkName}:` : '';
        return `${prefix}${relation.from.table}.${relation.from.column}->${relation.to.table}.${relation.to.column}`;
    });
}

function tableByName(schema, tableName) {
    return schema.tables.find((table) => table.name === tableName);
}

function columnByName(schema, tableName, columnName) {
    return tableByName(schema, tableName)?.columns.find((column) => column.name === columnName);
}

function assertRenderable(schema) {
    expect(Array.isArray(schema.enums)).toBe(true);
    expect(Array.isArray(schema.composites)).toBe(true);
    expect(Array.isArray(schema.tables)).toBe(true);
    expect(Array.isArray(schema.relations)).toBe(true);
    expect(Array.isArray(schema._parseErrors)).toBe(true);

    for (const table of schema.tables) {
        expect(table.name).toBeTruthy();
        expect(Array.isArray(table.columns)).toBe(true);
        for (const column of table.columns) {
            expect(column.name).toBeTruthy();
            expect(typeof column.type).toBe('string');
            expect(Array.isArray(column.constraints)).toBe(true);
            expect(Array.isArray(column.extras)).toBe(true);
        }
    }
}

function assertContainsAll(actual, expected = []) {
    for (const value of expected) {
        expect(actual).toContain(value);
    }
}

function assertColumn(schema, expectation) {
    const column = columnByName(schema, expectation.table, expectation.column);
    expect(column, `${expectation.table}.${expectation.column}`).toBeTruthy();

    if (expectation.type) expect(column.type).toBe(expectation.type);
    assertContainsAll(column.constraints, expectation.constraints);

    for (const extraNeedle of expectation.extras || []) {
        expect(column.extras.some((extra) => extra.includes(extraNeedle)), `${expectation.table}.${expectation.column} extra ${extraNeedle}`).toBe(true);
    }

    for (const flag of expectation.flags || []) {
        expect(column[flag], `${expectation.table}.${expectation.column}.${flag}`).toBe(true);
    }
}

describe('complex SQL fixture corpus - parseAST', () => {
    it('keeps the manifest synchronized with the fixture directory', () => {
        const discovered = readdirSync(fixtureDir)
            .filter((file) => file.endsWith('.sql'))
            .sort();
        const listed = fixtures.map((fixture) => fixture.fixture).sort();

        expect(listed).toEqual(discovered);
    });

    it.each(fixtures)('parses $fixture without diagnostics and preserves structural AST contracts', (fixture) => {
        const parsed = parseAST(readFixture(fixture.fixture));

        expect(parsed.errors).toEqual([]);
        expect(astTableNames(parsed)).toEqual(fixture.tables);
        expect(astTypeNames(parsed)).toEqual(fixture.types || []);
        expect(astIndexNames(parsed)).toEqual(fixture.indexes || []);
        assertContainsAll(astForeignNames(parsed), fixture.foreignNames);

        for (const columnExpectation of fixture.columns) {
            const table = parsed.ast.tables.find((item) => stripSchema(item.name) === columnExpectation.table);
            expect(table?.columns.some((column) => column.name === columnExpectation.column), `${fixture.fixture}:${columnExpectation.table}.${columnExpectation.column}`).toBe(true);
        }
    });
});

describe('complex SQL fixture corpus - sqlToErdSchema', () => {
    it.each(fixtures)('converts $fixture into a renderable production ERD contract', (fixture) => {
        const schema = sqlToErdSchema(readFixture(fixture.fixture));

        assertRenderable(schema);
        expect(schema._parseErrors).toEqual([]);
        expect(schema.tables.map((table) => table.name)).toEqual(fixture.tables);
        expect(schema.enums.map((type) => type.name).concat(schema.composites.map((type) => type.name))).toEqual(fixture.types || []);
        expect(relationKeys(schema)).toEqual(fixture.relations);

        for (const columnExpectation of fixture.columns) {
            assertColumn(schema, columnExpectation);
        }
    });
});
