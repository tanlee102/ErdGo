import { describe, expect, it } from 'vitest';
import { generateSampleData, inspectSampleSchema, SAMPLE_DATA_LIMITS } from '@/features/data-view/lib/sampleData';
import { createSqlExecutor } from '@/features/data-view/lib/sqlExecutor';

function generate(sql, overrides = {}, options = {}) {
    const model = inspectSampleSchema(sql, options.dialect);
    const tables = Object.fromEntries(model.tables.map(table => [table.name, { enabled: true, count: 10, ...overrides[table.name] }]));
    return generateSampleData({ sql, tables, ...options });
}
function replay(sql, result, dialect = 'auto') {
    const data = createSqlExecutor({ dialect }).execute(sql + '\n' + result.sql);
    expect(data.log.filter(item => item.type === 'error')).toEqual([]);
    return data.tables;
}

describe('local schema-aware sample data', () => {
    it.each(['constructor', '__proto__', 'toString'])('generates quoted SQL for the table %s without treating it as an inherited setting', name => {
        const sql = `CREATE TABLE "${name}"(id INT PRIMARY KEY, title TEXT NOT NULL);`;
        const tables = Object.fromEntries([[name, { enabled: true, count: 3, columns: { title: { generator: 'choice', choices: ['Sample title'] } } }]]);
        const result = generateSampleData({ sql, tables });
        expect(result.totalRows).toBe(3);
        expect(replay(sql, result).get(name).rows.map(row => row.title)).toEqual(['Sample title', 'Sample title', 'Sample title']);
    });
    it('uses repeatable realistic values with coherent people and existing primary keys', () => {
        const sql = `CREATE TABLE users(id INTEGER PRIMARY KEY, first_name VARCHAR(30), last_name VARCHAR(30), name VARCHAR(80), email VARCHAR(100) UNIQUE NOT NULL, age INT CHECK(age BETWEEN 18 AND 65)); INSERT INTO users(id,email) VALUES(100,'existing@example.com');`;
        const result = generate(sql, {}, { seed: 'repeatable' });
        expect(generate(sql, {}, { seed: 'repeatable' }).sql).toBe(result.sql);
        expect(generate(sql, {}, { seed: 'different' }).sql).not.toBe(result.sql);
        const rows = replay(sql, result).get('users').rows.slice(1);
        expect(rows).toHaveLength(10);
        for (const row of rows) {
            expect(row.id).toBeGreaterThan(100);
            expect(row.name).toBe(`${row.first_name} ${row.last_name}`);
            expect(row.email).toMatch(/@example\.com$/);
            expect(row.age).toBeGreaterThanOrEqual(18); expect(row.age).toBeLessThanOrEqual(65);
        }
    });
    it('orders parents first and copies complete composite foreign keys', () => {
        const sql = `CREATE TABLE parent(tenant INT, id INT, PRIMARY KEY(tenant,id)); CREATE TABLE child(id INT PRIMARY KEY, tenant INT NOT NULL, pid INT NOT NULL, FOREIGN KEY(tenant,pid) REFERENCES parent(tenant,id));`;
        const result = generate(sql, { parent: { count: 5 }, child: { count: 25 } });
        const tables = replay(sql, result);
        for (const row of tables.get('child').rows) expect(tables.get('parent').rows.some(parent => parent.tenant === row.tenant && parent.id === row.pid)).toBe(true);
    });
    it.each([[6, 4], [4, 6], [10, 10], [3, 5, 2], [4, 4, 4]].map(counts => ({ counts })))('fills independent junction-key combinations for parent counts $counts', ({ counts }) => {
        const names = counts.map((_, index) => `parent_${index}`);
        const fields = names.map((name, index) => `p${index}`);
        const sql = names.map(name => `CREATE TABLE ${name}(id INT PRIMARY KEY);`).join('\n') +
            `CREATE TABLE links(${names.map((name, index) => `${fields[index]} INT NOT NULL REFERENCES ${name}(id)`).join(',')}, PRIMARY KEY(${fields.join(',')}));`;
        const count = counts.reduce((product, value) => product * value, 1);
        const result = generate(sql, { ...Object.fromEntries(names.map((name, index) => [name, { count: counts[index] }])), links: { count } });
        const rows = replay(sql, result).get('links').rows;
        expect(new Set(rows.map(row => fields.map(field => row[field]).join(','))).size).toBe(count);
        fields.forEach((field, index) => {
            const frequencies = new Map();
            rows.forEach(row => frequencies.set(row[field], (frequencies.get(row[field]) || 0) + 1));
            expect(frequencies.size).toBe(counts[index]);
            expect([...frequencies.values()].every(value => value === count / counts[index])).toBe(true);
        });
    });
    it.each([[100, 5, 20], [6, 4, 4], [5, 9, 7]])('spreads a partial junction batch across %i and %i parents with %i rows', (people, tags, count) => {
        const sql = 'CREATE TABLE people(id INT PRIMARY KEY); CREATE TABLE tags(id INT PRIMARY KEY); CREATE TABLE links(person_id INT NOT NULL REFERENCES people(id), tag_id INT NOT NULL REFERENCES tags(id), PRIMARY KEY(person_id,tag_id));';
        const rows = replay(sql, generate(sql, { people: { count: people }, tags: { count: tags }, links: { count } })).get('links').rows;
        expect(new Set(rows.map(row => row.person_id)).size).toBe(Math.min(people, count));
        expect(new Set(rows.map(row => row.tag_id)).size).toBe(Math.min(tags, count));
    });
    it('keeps junction primary-key references non-null at 100% optional NULLs', () => {
        const sql = 'CREATE TABLE people(id INT PRIMARY KEY); CREATE TABLE tags(id INT PRIMARY KEY); CREATE TABLE links(person_id INT REFERENCES people(id), tag_id INT REFERENCES tags(id), PRIMARY KEY(person_id,tag_id));';
        const rows = replay(sql, generate(sql, { people: { count: 3 }, tags: { count: 2 }, links: { count: 6 } }, { nullPercent: 100 })).get('links').rows;
        expect(rows).toHaveLength(6);
        expect(rows.every(row => row.person_id != null && row.tag_id != null)).toBe(true);
    });
    it('skips existing junction tuples and rejects an exhausted combination domain', () => {
        const sql = 'CREATE TABLE people(id INT PRIMARY KEY); INSERT INTO people VALUES(1),(2),(3); CREATE TABLE tags(id INT PRIMARY KEY); INSERT INTO tags VALUES(1),(2); CREATE TABLE links(person_id INT NOT NULL REFERENCES people(id), tag_id INT NOT NULL REFERENCES tags(id), PRIMARY KEY(person_id,tag_id)); INSERT INTO links VALUES(1,1);';
        const parents = { people: { enabled: false }, tags: { enabled: false } };
        expect(replay(sql, generate(sql, { ...parents, links: { count: 5 } })).get('links').rows).toHaveLength(6);
        expect(() => generate(sql, { ...parents, links: { count: 6 } })).toThrow(/row 6.*duplicate composite PRIMARY KEY/);
    });
    it('can use existing parents without generating more parent rows', () => {
        const sql = `CREATE TABLE parents(id INT PRIMARY KEY); INSERT INTO parents VALUES(42); CREATE TABLE children(id INT PRIMARY KEY, parent_id INT NOT NULL REFERENCES parents(id));`;
        const result = generate(sql, { parents: { enabled: false } });
        expect(replay(sql, result).get('children').rows.every(row => row.parent_id === 42)).toBe(true);
        expect(result.sql).not.toContain('INSERT INTO "parents"');
    });
    it('reports missing required parents and required cycles without partial SQL', () => {
        const sql = `CREATE TABLE p(id INT PRIMARY KEY); CREATE TABLE c(id INT PRIMARY KEY, pid INT NOT NULL REFERENCES p(id));`;
        expect(() => generate(sql, { p: { enabled: false } })).toThrow(/generate rows for p/);
        const cycle = `CREATE TABLE a(id INT PRIMARY KEY, bid INT NOT NULL); CREATE TABLE b(id INT PRIMARY KEY, aid INT NOT NULL REFERENCES a(id)); ALTER TABLE a ADD FOREIGN KEY(bid) REFERENCES b(id);`;
        expect(() => generate(cycle)).toThrow(/cycle/);
    });
    it('handles nullable cycles and nullable self references', () => {
        const sql = `CREATE TABLE a(id INT PRIMARY KEY, bid INT); CREATE TABLE b(id INT PRIMARY KEY, aid INT REFERENCES a(id)); ALTER TABLE a ADD FOREIGN KEY(bid) REFERENCES b(id); CREATE TABLE staff(id INT PRIMARY KEY, manager_id INT REFERENCES staff(id));`;
        const result = generate(sql); const tables = replay(sql, result);
        expect(tables.get('a').rows.every(row => row.bid === null)).toBe(true);
        expect(result.notes.join(' ')).toMatch(/nullable references/);
        expect(tables.get('staff').rows).toHaveLength(10);
    });
    it('rejects exhausted unique domains and invalid CHECK constraints', () => {
        expect(() => generate(`CREATE TABLE t(id INT PRIMARY KEY, status TEXT UNIQUE CHECK(status IN ('open','closed')));`)).toThrow(/row 3/);
        expect(() => generate(`CREATE TABLE t(id INT PRIMARY KEY, amount INT CHECK(amount > 100000));`, { t: { columns: { amount: { generator: 'integer', max: 10 } } } })).toThrow(/range/);
    });
    it('respects CHECK choices, enums and custom values with SQL escaping', () => {
        const sql = `CREATE TYPE mood AS ENUM('calm','happy'); CREATE TABLE t(id INT PRIMARY KEY, state TEXT CHECK(state IN ('pending','done')), mood mood NOT NULL, title VARCHAR(60));`;
        const result = generate(sql, { t: { columns: { title: { generator: 'choice', choices: ["O'Brien", 'hello; DROP TABLE t; --', '你好'] } } } });
        const rows = replay(sql, result).get('t').rows;
        expect(rows[0].title).toBe("O'Brien"); expect(rows[1].title).toBe('hello; DROP TABLE t; --');
        expect(rows.every(row => ['pending', 'done'].includes(row.state))).toBe(true);
        expect(rows.every(row => ['calm', 'happy'].includes(row.mood))).toBe(true);
    });
    it.each(['postgres', 'mysql', 'mssql', 'sqlite'])('generates and replays %s SQL with quoted names and identity keys', dialect => {
        const identity = { postgres: 'INT GENERATED ALWAYS AS IDENTITY', mysql: 'INT AUTO_INCREMENT', mssql: 'INT IDENTITY(5,2)', sqlite: 'INTEGER' }[dialect];
        const quoted = dialect === 'mysql' ? '`Order Details`' : dialect === 'mssql' ? '[Order Details]' : '"Order Details"';
        const sql = `CREATE TABLE ${quoted}(id ${identity} PRIMARY KEY, enabled ${dialect === 'mssql' ? 'BIT' : 'BOOLEAN'}, email VARCHAR(100) UNIQUE); CREATE TABLE children(id INT PRIMARY KEY, parent_id INT NOT NULL REFERENCES ${quoted}(id));`;
        const result = generate(sql, {}, { dialect });
        expect(result.sql).toContain(`INSERT INTO ${inspectSampleSchema(sql, dialect).tables[0].sqlName}`);
        const tables = replay(sql, result, dialect);
        expect(tables.get('Order Details').rows).toHaveLength(10);
        expect(tables.get('children').rows).toHaveLength(10);
    });
    it('omits computed columns and validates their CHECK constraints', () => {
        const sql = `CREATE TABLE t(id INT PRIMARY KEY, amount DECIMAL(8,2) CHECK(amount >= 0), doubled DECIMAL(9,2) GENERATED ALWAYS AS (amount * 2) STORED);`;
        const result = generate(sql); const rows = replay(sql, result).get('t').rows;
        expect(result.sql).not.toMatch(/\("id", "amount", "doubled"\)/);
        expect(rows[0].doubled).toBeCloseTo(rows[0].amount * 2);
    });
    it('supports tables whose only column is an identity', () => {
        const sql = 'CREATE TABLE t(id INT IDENTITY(1,1) PRIMARY KEY);';
        const result = generate(sql, {}, { dialect: 'mssql' });
        expect(result.sql).toContain('DEFAULT VALUES');
        expect(replay(sql, result, 'mssql').get('t').rows).toHaveLength(10);
    });
    it('keeps schema qualification and rejects colliding leaf names', () => {
        const sql = 'CREATE TABLE billing.invoices(id INTEGER PRIMARY KEY);';
        const result = generate(sql); expect(result.sql).toContain('"billing"."invoices"'); replay(sql, result);
        expect(inspectSampleSchema('CREATE TABLE a.users(id INT); CREATE TABLE b.users(id INT);').errors.join(' ')).toMatch(/different schemas/);
    });
    it('generates after renames using the final table and columns', () => {
        const sql = 'CREATE TABLE old(id INT PRIMARY KEY, label TEXT); ALTER TABLE old RENAME TO current; ALTER TABLE current RENAME COLUMN label TO name;';
        const result = generate(sql); expect(result.sql).toContain('INSERT INTO "current"');
        expect(replay(sql, result).get('current').rows[0].name).toMatch(/\w+ \w+/);
    });
    it('bounds row counts, total cells and non-finite numeric settings', () => {
        const sql = 'CREATE TABLE t(id INT PRIMARY KEY, amount DECIMAL(8,2));';
        expect(() => generate(sql, { t: { count: SAMPLE_DATA_LIMITS.rowsPerTable + 1 } })).toThrow(/choose/);
        expect(() => generate(sql, { t: { count: 1.5 } })).toThrow(/choose/);
        expect(() => generate(sql, { t: { columns: { amount: { generator: 'decimal', min: 'Infinity' } } } })).toThrow(/range/);
    });
    it('does not turn newline-containing seeds into executable SQL', () => {
        const sql = 'CREATE TABLE t(id INT PRIMARY KEY);';
        const result = generate(sql, {}, { seed: '\nDROP TABLE t;\r\n--' });
        expect(replay(sql, result).get('t').rows).toHaveLength(10);
    });
    it('runs a substantial batch with bounded previews and progress', () => {
        const sql = 'CREATE TABLE t(id INT PRIMARY KEY, email VARCHAR(100) UNIQUE, name TEXT);';
        const tables = { t: { enabled: true, count: 1000 } }; const progress = [];
        const result = generateSampleData({ sql, tables }, value => progress.push(value));
        expect(result.previews[0].rows).toHaveLength(5);
        expect(replay(sql, result).get('t').rows).toHaveLength(1000);
        expect(progress.at(-1)).toMatchObject({ completed: 1000, total: 1000 });
    });
    it('generates parents before nullable children declared earlier', () => {
        const sql = 'CREATE TABLE child(id INT PRIMARY KEY, pid INT REFERENCES parent(id)); CREATE TABLE parent(id INT PRIMARY KEY);';
        const result = generate(sql);
        expect(result.previews.map(item => item.name)).toEqual(['parent', 'child']);
        expect(replay(sql, result).get('child').rows.every(row => row.pid != null)).toBe(true);
    });
    it('preserves PostgreSQL folding and explicitly quoted column identity', () => {
        const sql = 'CREATE TABLE Users(ID INT PRIMARY KEY, "DisplayName" TEXT);';
        const result = generate(sql, {}, { dialect: 'postgres' });
        expect(result.sql).toContain('INSERT INTO "users" ("id", "DisplayName")');
    });
    it('preserves unqualified connection context and refuses later namespace changes', () => {
        const sql = 'SET search_path=pg_temp; CREATE TEMP TABLE t(id INT PRIMARY KEY);';
        expect(generate(sql, {}, { dialect: 'postgres' }).sql).toContain('INSERT INTO "t"');
        expect(inspectSampleSchema('CREATE TABLE t(id INT); SET search_path=other;', 'postgres').errors.join(' ')).toMatch(/Qualify the table name/);
        expect(inspectSampleSchema('CREATE TABLE public.t(id INT); SET search_path=other;', 'postgres').errors).toEqual([]);
    });
    it('supports compact unique text keys and refuses numeric overflow', () => {
        const result = generate('CREATE TABLE t(id CHAR(1) PRIMARY KEY);');
        expect(new Set(result.previews[0].rows.map(row => row.id)).size).toBe(5);
        expect(() => generate('CREATE TABLE t(id TINYINT PRIMARY KEY); INSERT INTO t VALUES(127);')).toThrow(/numeric range/);
    });
});
