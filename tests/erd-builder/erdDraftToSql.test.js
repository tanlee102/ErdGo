/** Relational mapping regressions, SQL-to-ERD round trips, and real SQLite constraints. */
import { describe, expect, it } from 'vitest';
import { convertErdDraftToSql } from '@/features/erd-draft/lib/erdDraftToSql';
import { draftSqlIdentifier, quoteDraftSqlIdentifier, resolveDraftSqlType } from '@/features/erd-draft/lib/erdDraftSqlDialect';
import { healthcareDraft } from '@/features/erd-draft/data/draftTemplate';
import { sqlToErdSchema } from '@/lib/erdJsonSchema';

let DatabaseSync;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch { /* Native checks are optional on older Node versions. */ }

const node = (id, shape, label = id, extra = {}) => ({ id, data: { shape, label, ...extra } });
const edge = (id, source, target, data = {}) => ({ id, source, target, data });
const key = (id, label = 'id') => node(id, 'keyAttribute', label, { domain: 'INT' });
function binary(aMax = '1', bMax = 'N') {
    return { name: 'Shop', nodes: [node('a', 'entity', 'Customers'), key('ak'), node('b', 'entity', 'Orders'), key('bk'), node('r', 'relationship', 'Places')],
        edges: [edge('ak', 'a', 'ak'), edge('bk', 'b', 'bk'), edge('ar', 'a', 'r', { cardinalityMode: 'classic', sourceMax: aMax }), edge('br', 'b', 'r', { cardinalityMode: 'classic', sourceMax: bMax, lineCount: 'double' })] };
}
const errors = result => result.issues.filter(issue => issue.level === 'error');
const table = (result, name) => result.tables.find(table => table.name === name);
function complete(graph, options = {}) {
    let result = convertErdDraftToSql(graph, options);
    const decisions = { ...options.decisions };
    for (let pass = 0; pass < 4 && result.choices.some(choice => !choice.resolved); pass++) {
        for (const choice of result.choices) if (!choice.resolved) decisions[choice.key] = choice.kind === 'text' ? `role_${Object.keys(decisions).length}` : choice.options[0]?.value;
        result = convertErdDraftToSql(graph, { ...options, decisions });
    }
    return result;
}

describe('ERD Builder to relational SQL', () => {
    it.each(['sqlite', 'postgres', 'mysql', 'mssql'])('round-trips the complete healthcare starter through the %s SQL-to-ERD facade', dialect => {
        const snapshot = JSON.stringify(healthcareDraft);
        const result = complete(healthcareDraft, { dialect });
        expect(errors(result)).toEqual([]);
        expect(result.canConvert).toBe(true);
        const schema = sqlToErdSchema(result.sql, { dialect });
        expect(schema._parseErrors.filter(issue => issue.severity === 'error')).toEqual([]);
        expect(schema.tables).toHaveLength(result.tables.length);
        expect(schema.relations).toHaveLength(result.tables.reduce((count, table) => count + table.foreignKeys.length, 0));
        expect(JSON.stringify(healthcareDraft)).toBe(snapshot);
    });

    it('puts a classic 1:N foreign key on the many entity and uses its participation for nullability', () => {
        const result = convertErdDraftToSql(binary());
        expect(result.canConvert).toBe(true);
        expect(table(result, 'customers').foreignKeys).toEqual([]);
        expect(table(result, 'orders').foreignKeys).toEqual([expect.objectContaining({ target: 'customers', references: ['id'], nullable: false })]);
        expect(table(result, 'orders').columns.find(column => column.name === 'places_customers_id')).toMatchObject({ type: 'INT', nullable: false });
    });

    it('reverses min-max participation maxima relative to classic Chen ratio labels', () => {
        const graph = binary();
        Object.assign(graph.edges[2].data, { cardinalityMode: 'minmax', sourceMin: '0', sourceMax: 'N' });
        Object.assign(graph.edges[3].data, { cardinalityMode: 'minmax', sourceMin: '1', sourceMax: '1' });
        const result = convertErdDraftToSql(graph);
        expect(result.canConvert).toBe(true);
        expect(table(result, 'orders').foreignKeys[0]).toMatchObject({ target: 'customers', nullable: false });
        expect(table(result, 'customers').foreignKeys).toEqual([]);
    });

    it('uses participant keys and relationship attributes in a many-to-many junction', () => {
        const graph = binary('N', 'N');
        graph.nodes.push(node('qty', 'attribute', 'Quantity', { domain: 'INTEGER' }));
        graph.edges.push(edge('rq', 'r', 'qty'));
        const result = convertErdDraftToSql(graph);
        expect(result.canConvert).toBe(true);
        expect(table(result, 'places')).toMatchObject({ primaryKey: ['customers_id', 'orders_id'], foreignKeys: [expect.objectContaining({ target: 'customers' }), expect.objectContaining({ target: 'orders' })] });
        expect(table(result, 'places').columns.map(column => column.name)).toContain('quantity');
    });

    it.each(['sqlite', 'postgres', 'mysql', 'mssql'])('gives multivalued relationship attributes a real relationship identity on %s', dialect => {
        const graph = binary();
        graph.nodes.push(node('tags', 'multivaluedAttribute', 'Tags'));
        graph.edges.push(edge('tags', 'r', 'tags'));
        const result = convertErdDraftToSql(graph, { dialect });
        expect(result.canConvert).toBe(true);
        expect(table(result, 'orders').foreignKeys).toEqual([]);
        expect(table(result, 'places').unique).toContainEqual(['orders_id']);
        expect(table(result, 'places_tags').foreignKeys[0]).toMatchObject({ target: 'places', references: ['customers_id', 'orders_id'] });
        expect(result.issues.map(issue => issue.code)).toContain('multivalued-relationship-reified');
        expect(sqlToErdSchema(result.sql, { dialect })._parseErrors.filter(issue => issue.severity === 'error')).toEqual([]);
    });

    it('requires missing participation in mixed notations and blocks contradictory known bounds', () => {
        const graph = binary();
        Object.assign(graph.edges[2].data, { cardinalityMode: 'minmax', sourceMin: '0', sourceMax: 'N' });
        let result = convertErdDraftToSql(graph);
        expect(result.canConvert).toBe(false);
        expect(result.choices.map(choice => choice.key)).toContain('participation:br');
        result = convertErdDraftToSql(graph, { decisions: { 'participation:br': 'one' } });
        expect(result.canConvert).toBe(true);
        expect(table(result, 'orders').foreignKeys[0].target).toBe('customers');
        graph.edges[3].data.sourceMax = '1';
        expect(errors(convertErdDraftToSql(graph)).map(issue => issue.code)).toContain('conflicting-cardinality-notations');
    });

    it('normalizes leading-zero min-max bounds and refuses a zero maximum', () => {
        const graph = binary();
        Object.assign(graph.edges[2].data, { cardinalityMode: 'minmax', sourceMin: '0', sourceMax: 'N' });
        Object.assign(graph.edges[3].data, { cardinalityMode: 'minmax', sourceMin: '01', sourceMax: '01' });
        expect(table(convertErdDraftToSql(graph), 'orders').foreignKeys[0].target).toBe('customers');
        Object.assign(graph.edges[3].data, { sourceMin: '0', sourceMax: '00' });
        expect(convertErdDraftToSql(graph).canConvert).toBe(false);
    });

    it('preserves an n-ary classic functional dependency on the other role tuple', () => {
        const graph = binary('N', 'N');
        graph.nodes.push(node('c', 'entity', 'Products'), key('ck'));
        graph.edges.push(edge('ck', 'c', 'ck'), edge('cr', 'c', 'r', { cardinalityMode: 'classic', sourceMax: '1' }));
        const result = convertErdDraftToSql(graph);
        expect(table(result, 'places').primaryKey).toHaveLength(3);
        expect(table(result, 'places').unique).toContainEqual(['customers_id', 'orders_id']);
    });

    it('requires explicit choices for unknown cardinalities and ambiguous 1:1 placement', () => {
        const graph = binary('1', '1');
        graph.edges[3].data.lineCount = 'single';
        let result = convertErdDraftToSql(graph);
        expect(result.canConvert).toBe(false);
        expect(result.sql).toBe('');
        expect(result.choices.map(choice => choice.key)).toContain('holder:r');
        result = convertErdDraftToSql(graph, { dialect: 'mssql', decisions: { 'holder:r': '1' } });
        expect(result.canConvert).toBe(true);
        expect(result.sql).toContain('CREATE UNIQUE INDEX');
        expect(result.sql).toContain('WHERE [places_customers_id] IS NOT NULL');
        graph.edges[2].data = { sourceLabel: 'one customer perhaps' };
        result = convertErdDraftToSql(graph);
        expect(result.choices.some(choice => choice.key === 'cardinality:ar')).toBe(true);
    });

    it('flattens composite attributes, splits multivalues, and documents derived attributes', () => {
        const graph = binary();
        graph.nodes.push(node('addr', 'compositeAttribute', 'Address'), node('city', 'attribute', 'City'), node('phone', 'multivaluedAttribute', 'Phone'), node('age', 'derivedAttribute', 'Age', { derivation: 'year(now) - year(birth_date)' }));
        graph.edges.push(edge('aa', 'a', 'addr'), edge('ac', 'addr', 'city'), edge('ap', 'a', 'phone'), edge('ag', 'a', 'age'));
        const result = convertErdDraftToSql(graph);
        expect(table(result, 'customers').columns.map(column => column.name)).toContain('address_city');
        expect(table(result, 'customers_phone').primaryKey).toEqual(['customers_id', 'phone']);
        expect(table(result, 'customers').columns.map(column => column.name)).not.toContain('age');
        expect(result.sql).toContain('year(now) - year(birth_date)');
        const stored = convertErdDraftToSql(graph, { derivedAttributes: 'store' });
        expect(table(stored, 'customers').columns.map(column => column.name)).toContain('age');
        expect(stored.issues.map(issue => issue.code)).toContain('derived-attribute-stored');
    });

    it('uses all composite owner columns plus the partial discriminator for weak identity', () => {
        const graph = { nodes: [node('a', 'entity', 'Employee'), key('tenant', 'tenant_id'), key('employee', 'employee_id'), node('w', 'weakEntity', 'Dependent'), node('name', 'partialKeyAttribute', 'Name'), node('r', 'identifyingRelationship', 'Has')], edges: [edge('at', 'a', 'tenant'), edge('ae', 'a', 'employee'), edge('wn', 'w', 'name'), edge('ar', 'a', 'r'), edge('wr', 'w', 'r', { lineCount: 'double', sourceLabel: 'N' })] };
        const result = convertErdDraftToSql(graph);
        expect(result.canConvert).toBe(true);
        expect(table(result, 'dependent').primaryKey).toEqual(['employee_has_employee_id', 'employee_has_tenant_id', 'name']);
        expect(table(result, 'dependent').foreignKeys[0].references).toEqual(['employee_id', 'tenant_id']);
        expect(result.tables.some(table => table.name === 'has')).toBe(false);
        graph.nodes = graph.nodes.filter(node => node.id !== 'name');
        graph.edges = graph.edges.filter(edge => edge.id !== 'wn');
        expect(convertErdDraftToSql(graph).canConvert).toBe(false);
    });

    it('maps subtype keys from explicitly assigned roles and blocks inheritance cycles', () => {
        const graph = { nodes: [node('p', 'entity', 'Person'), key('pk'), node('c', 'entity', 'Student'), node('i', 'isa', 'ISA')], edges: [edge('pk', 'p', 'pk'), edge('pi', 'p', 'i'), edge('ci', 'c', 'i')] };
        expect(convertErdDraftToSql(graph).choices.map(choice => choice.key)).toEqual(['isaRole:ci', 'isaRole:pi']);
        const result = convertErdDraftToSql(graph, { decisions: { 'isaRole:pi': 'supertype', 'isaRole:ci': 'subtype' } });
        expect(result.canConvert).toBe(true);
        expect(table(result, 'student').primaryKey).toEqual(['person_id']);
        expect(table(result, 'student').foreignKeys[0].target).toBe('person');
        expect(result.issues.map(issue => issue.code)).toContain('specialization-enforcement');
        graph.nodes.push(node('i2', 'isa'));
        graph.edges.push(edge('ci2', 'c', 'i2', { isaRole: 'supertype' }), edge('pi2', 'p', 'i2', { isaRole: 'subtype' }));
        expect(convertErdDraftToSql(graph, { decisions: { 'isaRole:pi': 'supertype', 'isaRole:ci': 'subtype' } }).canConvert).toBe(false);
    });

    it('blocks identifying cardinalities that allow multiple owners of one weak instance', () => {
        const graph = { nodes: [node('a', 'entity', 'Owner'), key('ak'), node('w', 'weakEntity', 'Dependent'), node('name', 'partialKeyAttribute', 'Name'), node('r', 'identifyingRelationship', 'Has')], edges: [edge('ak', 'a', 'ak'), edge('wn', 'w', 'name'), edge('ar', 'a', 'r', { sourceLabel: 'N' }), edge('wr', 'w', 'r', { lineCount: 'double', sourceLabel: 'N' })] };
        expect(errors(convertErdDraftToSql(graph)).map(issue => issue.code)).toContain('weak-ownership-cardinality');
        graph.edges[2].data.sourceLabel = '1';
        expect(convertErdDraftToSql(graph).canConvert).toBe(true);
    });

    it('rejects explicitly optional or impossible weak ownership and conflicting identifying bounds', () => {
        const graph = { nodes: [node('a', 'entity', 'Owner'), key('ak'), node('w', 'weakEntity', 'Dependent'), node('name', 'partialKeyAttribute', 'Name'), node('r', 'identifyingRelationship', 'Has')], edges: [edge('ak', 'a', 'ak'), edge('wn', 'w', 'name'), edge('ar', 'a', 'r', { cardinalityMode: 'minmax', sourceMin: '0', sourceMax: 'N' }), edge('wr', 'w', 'r', { cardinalityMode: 'minmax', sourceMin: '0', sourceMax: '1', lineCount: 'double' })] };
        expect(errors(convertErdDraftToSql(graph)).map(issue => issue.code)).toContain('weak-ownership-optional');
        Object.assign(graph.edges[3].data, { sourceMin: '1', sourceMax: '0' });
        expect(convertErdDraftToSql(graph).canConvert).toBe(false);
        Object.assign(graph.edges[3].data, { cardinalityMode: 'classic', sourceLabel: '1', sourceMin: '0', sourceMax: '1' });
        expect(errors(convertErdDraftToSql(graph)).map(issue => issue.code)).toContain('conflicting-cardinality-notations');
    });

    it('keeps n-ary identifying uniqueness and finite owner participation limits', () => {
        const graph = { nodes: [node('a', 'entity', 'Owner'), key('ak'), node('b', 'entity', 'Tenant'), key('bk'), node('w', 'weakEntity', 'Dependent'), node('name', 'partialKeyAttribute', 'Name'), node('r', 'identifyingRelationship', 'Has')], edges: [edge('ak', 'a', 'ak'), edge('bk', 'b', 'bk'), edge('wn', 'w', 'name'), edge('ar', 'a', 'r', { sourceLabel: '1' }), edge('br', 'b', 'r', { sourceLabel: '1' }), edge('wr', 'w', 'r', { sourceLabel: '1', lineCount: 'double' })] };
        const result = convertErdDraftToSql(graph);
        expect(result.canConvert).toBe(true);
        expect(table(result, 'dependent').unique).toContainEqual(['owner_has_id', 'tenant_has_id']);
        Object.assign(graph.edges[3].data, { cardinalityMode: 'minmax', sourceMin: '0', sourceMax: '5' });
        const bounded = convertErdDraftToSql(graph);
        expect(bounded.issues.map(issue => issue.code)).toContain('participation-bounds-enforcement');
    });

    it('asks for an unknown dependent maximum and carries the selected uniqueness into the weak table', () => {
        const graph = { nodes: [node('a', 'entity', 'Owner'), key('ak'), node('w', 'weakEntity', 'Dependent'), node('name', 'partialKeyAttribute', 'Name'), node('r', 'identifyingRelationship', 'Has')], edges: [edge('ak', 'a', 'ak'), edge('wn', 'w', 'name'), edge('ar', 'a', 'r'), edge('wr', 'w', 'r', { lineCount: 'double' })] };
        const pending = convertErdDraftToSql(graph);
        expect(pending.canConvert).toBe(false);
        expect(pending.choices).toContainEqual(expect.objectContaining({ key: 'weakMaximum:r', resolved: false }));
        const one = convertErdDraftToSql(graph, { decisions: { 'weakMaximum:r': 'one' } });
        expect(one.canConvert).toBe(true);
        expect(table(one, 'dependent').unique).toContainEqual(['owner_has_id']);
        const many = convertErdDraftToSql(graph, { decisions: { 'weakMaximum:r': 'many' } });
        expect(many.canConvert).toBe(true);
        expect(table(many, 'dependent').unique).toEqual([]);
    });

    it('asks category roles only for entities, not a relationship attached to the category', () => {
        const graph = { nodes: [node('p', 'entity', 'Person'), key('pk'), node('c', 'entity', 'Company'), key('ck'), node('o', 'entity', 'Owner'), key('ok'), node('u', 'category', 'Owner category'), node('r', 'relationship', 'Uses')], edges: [edge('pk', 'p', 'pk'), edge('ck', 'c', 'ck'), edge('ok', 'o', 'ok'), edge('pu', 'p', 'u', { categoryRole: 'member' }), edge('cu', 'c', 'u', { categoryRole: 'member' }), edge('ou', 'o', 'u', { categoryRole: 'result' }), edge('ur', 'u', 'r', { sourceLabel: '1' }), edge('pr', 'p', 'r', { sourceLabel: 'N' })] };
        const result = convertErdDraftToSql(graph);
        expect(result.choices).toEqual([]);
        expect(result.canConvert).toBe(true);
        expect(table(result, 'person').foreignKeys[0].target).toBe('owner');
    });

    it('asks for distinct recursive roles and preserves both references to the same entity', () => {
        const graph = { nodes: [node('a', 'entity', 'Employee'), key('ak'), node('r', 'relationship', 'Mentors')], edges: [edge('ak', 'a', 'ak'), edge('r1', 'a', 'r', { sourceLabel: 'N' }), edge('r2', 'a', 'r', { sourceLabel: 'N' })] };
        const result = convertErdDraftToSql(graph, { decisions: { 'role:r1': 'Mentor', 'role:r2': 'Mentee' } });
        expect(result.canConvert).toBe(true);
        expect(table(result, 'mentors').primaryKey).toEqual(['mentor_id', 'mentee_id']);
        expect(table(result, 'mentors').foreignKeys.map(fk => fk.target)).toEqual(['employee', 'employee']);
        expect(convertErdDraftToSql(graph).canConvert).toBe(false);
        expect(convertErdDraftToSql(graph, { decisions: { 'role:r1': 'same', 'role:r2': 'Same' } }).canConvert).toBe(false);
    });

    it('requires an explicit aggregation source and reifies that relationship before referencing it', () => {
        const graph = binary('N', 'N');
        graph.nodes.push(node('agg', 'aggregation', 'Assignment'), node('c', 'entity', 'Supervisor'), key('ck'), node('outer', 'relationship', 'Approves'));
        graph.edges.push(edge('ck', 'c', 'ck'), edge('inside', 'r', 'agg'), edge('outside', 'agg', 'outer', { sourceLabel: 'N' }), edge('supervises', 'c', 'outer', { sourceLabel: 'N' }));
        const result = convertErdDraftToSql(graph, { decisions: { 'aggregation:agg': 'r' } });
        expect(result.canConvert).toBe(true);
        expect(table(result, 'approves').foreignKeys.map(fk => fk.target)).toContain('places');
        expect(convertErdDraftToSql(graph).canConvert).toBe(false);
    });

    it('blocks shared attributes, unsupported semantic edges, and identity cycles instead of discarding them', () => {
        const graph = binary();
        graph.edges.push(edge('shared', 'b', 'ak'));
        expect(errors(convertErdDraftToSql(graph)).map(issue => issue.code)).toContain('attribute-multiple-owners');
        graph.edges.at(-1).data.connectionKind = 'annotation';
        expect(convertErdDraftToSql(graph).canConvert).toBe(true);
        graph.edges.push(edge('bad', 'a', 'b'));
        expect(convertErdDraftToSql(graph).canConvert).toBe(false);
    });

    it('uses a stable graph snapshot, ignores layout/annotation changes, and disambiguates normalized names', () => {
        const graph = binary();
        graph.nodes.push(node('extra', 'entity', 'Customers'), node('note', 'note', 'Review\nDROP TABLE users;'));
        graph.edges.push(edge('annotation', 'extra', 'a', { connectionKind: 'annotation' }));
        const before = JSON.stringify(graph);
        const result = convertErdDraftToSql(graph);
        expect(result.canConvert).toBe(true);
        expect(result.tables.map(table => table.name)).toContain('customers_2');
        expect(result.sql).toContain('-- Note: Review DROP TABLE users;');
        const shuffled = { ...graph, nodes: [...graph.nodes].reverse().map(node => ({ ...node, hidden: true, position: { x: 123, y: 456 } })), edges: [...graph.edges].reverse() };
        expect(convertErdDraftToSql(shuffled).sql).toBe(result.sql);
        expect(JSON.stringify(graph)).toBe(before);
    });
});

describe('SQL export dialect boundary', () => {
    it.each([['mysql', 'VARCHAR(1000)'], ['mssql', 'NVARCHAR(500)']])('blocks an oversized %s primary key instead of silently truncating it', (dialect, domain) => {
        const graph = { nodes: [node('a', 'entity', 'Account'), node('ak', 'keyAttribute', 'Code', { domain })], edges: [edge('ak', 'a', 'ak')] };
        const result = convertErdDraftToSql(graph, { dialect });
        expect(result.sql).toBe('');
        expect(errors(result).map(issue => issue.code)).toContain('key-width-exceeded');
        expect(table(result, 'account').columns[0].type).toBe(domain);
        expect(convertErdDraftToSql(graph, { dialect, attributeTypes: { ak: 'integer' } }).canConvert).toBe(true);
    });

    it('validates combined junction key widths and key column counts after mapping', () => {
        const graph = binary('N', 'N');
        graph.nodes.filter(node => node.data.shape === 'keyAttribute').forEach(node => { node.data.domain = 'VARCHAR(400)'; });
        const result = convertErdDraftToSql(graph, { dialect: 'mysql' });
        expect(errors(result).find(issue => issue.code === 'key-width-exceeded').nodeId).toBe('r');
        const wide = { nodes: [node('a', 'entity', 'Wide'), ...Array.from({ length: 33 }, (_, i) => key(`k${i}`, `k${i}`))], edges: Array.from({ length: 33 }, (_, i) => edge(`e${i}`, 'a', `k${i}`)) };
        for (const dialect of ['postgres', 'mysql', 'mssql']) expect(errors(convertErdDraftToSql(wide, { dialect })).map(issue => issue.code)).toContain('key-column-limit');
    });

    it('bounds names, escapes quotes, and treats malicious domains as data', () => {
        expect(draftSqlIdentifier('123 order / item')).toBe('_123_order_item');
        expect(draftSqlIdentifier('x'.repeat(100))).toHaveLength(63);
        expect(quoteDraftSqlIdentifier('a`b', 'mysql')).toBe('`a``b`');
        expect(quoteDraftSqlIdentifier('a]b', 'mssql')).toBe('[a]]b]');
        expect(resolveDraftSqlType('INT); DROP TABLE users; --', 'auto', 'postgres')).toMatchObject({ type: 'VARCHAR(255)', assumed: true });
        expect(resolveDraftSqlType('decimal(12,2)', 'auto', 'mysql')).toMatchObject({ type: 'DECIMAL(12, 2)', assumed: false });
        expect(resolveDraftSqlType('uuid', 'auto', 'mssql').type).toBe('UNIQUEIDENTIFIER');
        expect(resolveDraftSqlType('timestamp', 'auto', 'mssql').type).toBe('DATETIME2');
    });
});

describe.skipIf(!DatabaseSync)('generated DDL on native SQLite', () => {
    it('rejects multivalued relationship data until its exact participating tuple exists', () => {
        const graph = binary();
        graph.nodes.push(node('tags', 'multivaluedAttribute', 'Tags'));
        graph.edges.push(edge('tags', 'r', 'tags'));
        const result = convertErdDraftToSql(graph, { dialect: 'sqlite' });
        const db = new DatabaseSync(':memory:');
        try {
            db.exec(result.sql);
            db.exec('INSERT INTO customers VALUES (1); INSERT INTO orders VALUES (10);');
            expect(() => db.exec("INSERT INTO places_tags VALUES (1, 10, 'priority');")).toThrow(/FOREIGN KEY/);
            db.exec("INSERT INTO places VALUES (1, 10); INSERT INTO places_tags VALUES (1, 10, 'priority');");
            expect(() => db.exec('DELETE FROM places;')).toThrow(/FOREIGN KEY/);
            expect(() => db.exec('INSERT INTO customers VALUES (2); INSERT INTO places VALUES (2, 10);')).toThrow(/UNIQUE/);
        } finally { db.close(); }
    });

    it('enforces required references and composite multivalued uniqueness', () => {
        const graph = binary();
        graph.nodes.push(node('phone', 'multivaluedAttribute', 'Phone'));
        graph.edges.push(edge('ap', 'a', 'phone'));
        const db = new DatabaseSync(':memory:');
        try {
            db.exec(convertErdDraftToSql(graph, { dialect: 'sqlite' }).sql);
            db.exec('INSERT INTO customers (id) VALUES (1); INSERT INTO orders (id, places_customers_id) VALUES (10, 1);');
            expect(() => db.exec('INSERT INTO orders (id, places_customers_id) VALUES (11, 999);')).toThrow(/FOREIGN KEY/);
            expect(() => db.exec('INSERT INTO orders (id) VALUES (12);')).toThrow(/NOT NULL/);
            db.exec("INSERT INTO customers_phone VALUES (1, '123');");
            expect(() => db.exec("INSERT INTO customers_phone VALUES (1, '123');")).toThrow(/UNIQUE/);
        } finally { db.close(); }
    });

    it('allows multiple optional 1:1 NULLs, but rejects duplicate references and partial composite NULLs', () => {
        const graph = binary('1', '1');
        graph.nodes.push(key('tenant', 'tenant'));
        graph.edges.push(edge('tenant-key', 'a', 'tenant'));
        graph.edges[3].data.lineCount = 'single';
        const db = new DatabaseSync(':memory:');
        try {
            db.exec(convertErdDraftToSql(graph, { dialect: 'sqlite', decisions: { 'holder:r': '1' } }).sql);
            db.exec('INSERT INTO customers VALUES (1, 2); INSERT INTO orders (id) VALUES (10), (11);');
            expect(() => db.exec('INSERT INTO orders VALUES (12, 1, NULL);')).toThrow(/CHECK/);
            db.exec('INSERT INTO orders VALUES (12, 1, 2);');
            expect(() => db.exec('INSERT INTO orders VALUES (13, 1, 2);')).toThrow(/UNIQUE/);
        } finally { db.close(); }
    });

    it('enforces exactly one union member and preserves joined subtype identities', () => {
        const graph = { nodes: [node('p', 'entity', 'Person'), key('pk'), node('c', 'entity', 'Company'), key('ck'), node('o', 'entity', 'Owner'), key('ok'), node('u', 'category', 'Owner category')], edges: [edge('pk', 'p', 'pk'), edge('ck', 'c', 'ck'), edge('ok', 'o', 'ok'), edge('pu', 'p', 'u', { categoryRole: 'member' }), edge('cu', 'c', 'u', { categoryRole: 'member' }), edge('ou', 'o', 'u', { categoryRole: 'result' })] };
        const result = convertErdDraftToSql(graph, { dialect: 'sqlite' });
        expect(result.canConvert).toBe(true);
        const db = new DatabaseSync(':memory:');
        try {
            db.exec(result.sql);
            db.exec('INSERT INTO company VALUES (1); INSERT INTO person VALUES (2);');
            expect(() => db.exec('INSERT INTO owner (id) VALUES (10);')).toThrow(/CHECK/);
            db.exec('INSERT INTO owner VALUES (10, 1, NULL);');
            expect(() => db.exec('INSERT INTO owner VALUES (11, 1, 2);')).toThrow();
        } finally { db.close(); }
    });
});
