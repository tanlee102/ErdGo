import { describe, expect, it } from 'vitest';
import { generateSampleData } from '@/features/data-view/lib/sampleData';
import { SAMPLE_GENERATORS, SAMPLE_NAME_DICTIONARIES } from '@/features/data-view/lib/sampleDataGenerators';
import { SAMPLE_DATA_CATALOG, SAMPLE_NAME_PROFILES } from '@/features/data-view/lib/sampleDataCatalog';
import { createSampleRandom, samplePerson } from '@/features/data-view/lib/sampleDataValues';
import { normalizeSampleValue } from '@/features/data-view/lib/sampleDataTypes';
import { createSqlExecutor } from '@/features/data-view/lib/sqlExecutor';

function fixture(sql, tables, extra = {}) {
    const result = generateSampleData({ sql, tables, ...extra });
    const data = createSqlExecutor({ dialect: extra.dialect || 'auto' }).execute(sql + '\n' + result.sql);
    expect(data.log.filter(entry => entry.type === 'error')).toEqual([]);
    return { ...result, tables: data.tables };
}

const types = { sequence: 'INTEGER', uuid: 'UUID', integer: 'INTEGER', decimal: 'DECIMAL(8,2)', boolean: 'BOOLEAN', date: 'DATE', time: 'TIME', datetime: 'TIMESTAMP', json: 'JSONB', latitude: 'DECIMAL(10,6)', longitude: 'DECIMAL(10,6)', countryCode: 'CHAR(2)', currency: 'CHAR(3)' };

describe('sample dictionary and scalar coverage', () => {
    it('provides varied, distinct pools for every selectable country dictionary', () => {
        expect(SAMPLE_NAME_DICTIONARIES).toHaveLength(27);
        expect(new Set(SAMPLE_NAME_DICTIONARIES.map(item => item.id))).toEqual(new Set(Object.keys(SAMPLE_NAME_PROFILES)));
        const nameEntries = Object.values(SAMPLE_NAME_PROFILES).reduce((total, profile) => total + profile.firstNames.length + profile.lastNames.length, 0);
        const otherEntries = Object.entries(SAMPLE_DATA_CATALOG).filter(([name]) => !/Names$/.test(name)).reduce((total, [, values]) => total + values.length, 0);
        expect(nameEntries).toBeGreaterThan(2600);
        expect(nameEntries + otherEntries).toBeGreaterThan(4200);
        for (const [locale, profile] of Object.entries(SAMPLE_NAME_PROFILES)) {
            for (const pool of [profile.firstNames, profile.lastNames]) {
                expect(pool.length).toBeGreaterThanOrEqual(32);
                expect(new Set(pool.map(entry => entry[0])).size).toBe(pool.length);
                // Every name, not just the random sample, must have a readable ASCII handle.
                pool.forEach((entry, index) => {
                    const person = samplePerson(() => (index + 0.5) / pool.length, locale);
                    expect(entry[0].trim()).toBe(entry[0]);
                    expect(person.firstHandle).toMatch(/^[a-z]+(?:\.[a-z]+)*$/);
                    expect(person.lastHandle).toMatch(/^[a-z]+(?:\.[a-z]+)*$/);
                });
            }
        }
    });
    it.each(SAMPLE_NAME_DICTIONARIES.map(item => [item.id, item.label]))('replays coherent, repeatable %s names (%s) as valid SQL', (locale) => {
        const sql = 'CREATE TABLE people(id INT PRIMARY KEY, first_name TEXT NOT NULL, last_name TEXT NOT NULL, name TEXT NOT NULL, email VARCHAR(120) UNIQUE NOT NULL, username VARCHAR(120) UNIQUE NOT NULL);';
        const tables = { people: { enabled: true, count: 48 } };
        const result = fixture(sql, tables, { locale, seed: 'country-names' });
        expect(generateSampleData({ sql, tables, locale, seed: 'country-names' }).sql).toBe(result.sql);
        const profile = SAMPLE_NAME_PROFILES[locale];
        for (const row of result.tables.get('people').rows) {
            const first = profile.firstNames.find(([name]) => name === row.first_name);
            const last = profile.lastNames.find(([name]) => name === row.last_name);
            expect(first).toBeDefined(); expect(last).toBeDefined();
            expect(row.name).toBe((profile.familyFirst ? [row.last_name, row.first_name] : [row.first_name, row.last_name]).join(profile.separator));
            expect(row.email).toMatch(/^[a-z]+(?:\.[a-z]+)*\.\d+@example\.com$/);
            expect(row.username).toMatch(/^[a-z_.]+\d+$/);
            expect(row.email).toBe(`${first[1]}.${last[1]}.${row.id}@example.com`);
            expect(row.username).toBe(`${first[1].replace(/\./g, '_')}_${last[1]}${row.id}`);
        }
    });
    it.each([
        ['zh-CN', '伟', '王', '王伟', 'wei', 'wang'],
        ['ja-JP', '陽翔', '佐藤', '佐藤陽翔', 'haruto', 'sato'],
        ['ko-KR', '민준', '김', '김민준', 'minjun', 'kim'],
        ['ar-SA', 'عبدالله', 'العنزي', 'عبدالله العنزي', 'abdullah', 'alenezi'],
    ])('keeps native %s spelling, name order and romanized handles', (locale, first, last, fullName, firstHandle, lastHandle) => {
        expect(samplePerson(() => 0, locale)).toMatchObject({ first, last, fullName, firstHandle, lastHandle });
    });
    it.each(['unknown', '__proto__', 'constructor'])('uses general English for the unrecognized dictionary %s', locale => {
        expect(samplePerson(createSampleRandom('fallback'), locale)).toEqual(samplePerson(createSampleRandom('fallback'), 'en'));
    });
    it('recognizes timestamp/date/time names in text-backed schemas without overriding native types', () => {
        const sql = 'CREATE TABLE t(id INT PRIMARY KEY, created_at TEXT, updatedAt VARCHAR(30), last_seen_at TEXT, birth_date TEXT, start_time TEXT, located_at TEXT, switch_on TEXT, expires_at INT);';
        const result = fixture(sql, { t: { enabled: true, count: 20 } });
        for (const row of result.tables.get('t').rows) {
            for (const name of ['created_at', 'updatedAt', 'last_seen_at']) expect(row[name]).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
            expect(row.birth_date).toMatch(/^\d{4}-\d\d-\d\d$/);
            expect(row.start_time).toMatch(/^\d\d:\d\d:\d\d$/);
            expect(row.located_at).toContain('sample');
            expect(row.switch_on).toContain('sample');
            expect(Number.isInteger(row.expires_at)).toBe(true);
        }
    });
    it('keeps the expanded catalog varied and location records internally coherent', () => {
        expect(Object.values(SAMPLE_DATA_CATALOG).reduce((total, values) => total + values.length, 0)).toBeGreaterThan(1000);
        expect(SAMPLE_DATA_CATALOG.companies.length).toBeGreaterThan(250);
        expect(SAMPLE_DATA_CATALOG.products.length).toBeGreaterThan(350);
        expect(SAMPLE_DATA_CATALOG.jobTitles.length).toBeGreaterThan(190);
        expect(SAMPLE_DATA_CATALOG.descriptions.length).toBeGreaterThanOrEqual(80);
        for (const [name, values] of Object.entries(SAMPLE_DATA_CATALOG)) {
            if (name !== 'places') expect(new Set(values).size).toBe(values.length);
        }
        const countries = new Map();
        expect(SAMPLE_DATA_CATALOG.places.length).toBeGreaterThan(80);
        for (const [city, country, postal, code, currency, latitude, longitude] of SAMPLE_DATA_CATALOG.places) {
            expect(city && country && postal).toBeTruthy();
            expect(code).toMatch(/^[A-Z]{2}$/); expect(currency).toMatch(/^[A-Z]{3}$/);
            expect(latitude).toBeGreaterThanOrEqual(-90); expect(latitude).toBeLessThanOrEqual(90);
            expect(longitude).toBeGreaterThanOrEqual(-180); expect(longitude).toBeLessThanOrEqual(180);
            if (countries.has(country)) expect(countries.get(country)).toEqual([code, currency]);
            countries.set(country, [code, currency]);
        }
        expect(countries.size).toBeGreaterThan(40);
    });
    it.each(SAMPLE_GENERATORS.filter(item => !['auto', 'default', 'null'].includes(item.id)).map(item => [item.id]))('generates usable %s values', generator => {
        const sql = `CREATE TABLE t(id INT PRIMARY KEY, value ${types[generator] || 'VARCHAR(250)'} NOT NULL);`;
        const result = fixture(sql, { t: { enabled: true, count: 40, columns: { value: { generator, ...(generator === 'choice' ? { choices: ['alpha', 'beta', 'gamma'] } : {}) } } } });
        expect(result.tables.get('t').rows).toHaveLength(40);
        expect(result.tables.get('t').rows.every(row => row.value !== null)).toBe(true);
    });
    it('fills a unique numeric domain without stochastic exhaustion and includes its bounds', () => {
        const sql = 'CREATE TABLE t(id INT PRIMARY KEY, code INT UNIQUE CHECK(code BETWEEN 0 AND 99));';
        const result = fixture(sql, { t: { enabled: true, count: 100 } });
        const codes = result.tables.get('t').rows.map(row => row.code);
        expect(new Set(codes).size).toBe(100); expect(Math.min(...codes)).toBe(0); expect(Math.max(...codes)).toBe(99);
    });
    it('uses the remaining enum value when a unique domain already has rows', () => {
        const sql = "CREATE TABLE t(id INT PRIMARY KEY, state TEXT UNIQUE CHECK(state IN ('open','closed'))); INSERT INTO t VALUES(1,'open');";
        const result = fixture(sql, { t: { enabled: true, count: 1 } });
        expect(result.tables.get('t').rows[1].state).toBe('closed');
    });
    it('generates complete unique date/time ranges and rejects true exhaustion', () => {
        const sql = 'CREATE TABLE t(id INT PRIMARY KEY, day DATE UNIQUE, moment TIME UNIQUE, payload JSONB UNIQUE);';
        const tables = { t: { enabled: true, count: 31, columns: { day: { generator: 'date', startDate: '2024-01-01', endDate: '2024-01-31' } } } };
        const result = fixture(sql, tables); const rows = result.tables.get('t').rows;
        expect(new Set(rows.map(row => row.day)).size).toBe(31);
        expect(rows.every(row => JSON.parse(row.payload).id > 0)).toBe(true);
        expect(() => fixture(sql, { t: { ...tables.t, count: 32 } })).toThrow(/unique date\/time range is exhausted/);
    });
    it('spreads child rows over every parent with balanced participation', () => {
        const sql = 'CREATE TABLE p(id INT PRIMARY KEY); CREATE TABLE c(id INT PRIMARY KEY, pid INT NOT NULL REFERENCES p(id));';
        const result = fixture(sql, { p: { enabled: true, count: 40 }, c: { enabled: true, count: 400 } });
        const counts = new Map();
        result.tables.get('c').rows.forEach(row => counts.set(row.pid, (counts.get(row.pid) || 0) + 1));
        expect(counts.size).toBe(40); expect(new Set(counts.values())).toEqual(new Set([10]));
    });
    it('covers every parent exactly once for a one-to-one FK', () => {
        const sql = 'CREATE TABLE p(id INT PRIMARY KEY); CREATE TABLE profile(id INT PRIMARY KEY, pid INT NOT NULL UNIQUE REFERENCES p(id));';
        const result = fixture(sql, { p: { enabled: true, count: 100 }, profile: { enabled: true, count: 100 } });
        expect(new Set(result.tables.get('profile').rows.map(row => row.pid)).size).toBe(100);
    });
    it('keeps locations, country codes, currencies and Vietnamese names coherent', () => {
        const sql = 'CREATE TABLE people(id INT PRIMARY KEY, first_name TEXT, last_name TEXT, name TEXT, email VARCHAR(100), city TEXT, country TEXT, country_code CHAR(2), currency CHAR(3), latitude DECIMAL(10,6), longitude DECIMAL(10,6));';
        const result = fixture(sql, { people: { enabled: true, count: 160 } }, { locale: 'vi' });
        const rows = result.tables.get('people').rows;
        expect(new Set(rows.map(row => row.city)).size).toBe(SAMPLE_DATA_CATALOG.places.length);
        const places = new Map(SAMPLE_DATA_CATALOG.places.map(place => [place[0], place]));
        for (const row of rows) {
            expect(row.name).toBe(`${row.last_name} ${row.first_name}`);
            expect(row.email).toMatch(/^[a-z0-9.]+@example\.com$/);
            const place = places.get(row.city);
            expect([row.country, row.country_code, row.currency]).toEqual([place[1], place[3], place[4]]);
            expect(Math.abs(row.latitude - place[5])).toBeLessThan(0.003);
            expect(Math.abs(row.longitude - place[6])).toBeLessThan(0.003);
            if (row.country === 'Vietnam') { expect(row.country_code).toBe('VN'); expect(row.currency).toBe('VND'); expect(row.latitude).toBeGreaterThan(10); expect(row.longitude).toBeGreaterThan(100); }
        }
    });
    it('adds optional null coverage while keeping primary and required fields populated', () => {
        const sql = 'CREATE TABLE p(id INT PRIMARY KEY, name TEXT NOT NULL, note TEXT); CREATE TABLE c(id INT PRIMARY KEY, pid INT REFERENCES p(id));';
        const result = fixture(sql, { p: { enabled: true, count: 10 }, c: { enabled: true, count: 10 } }, { nullPercent: 100 });
        expect(result.tables.get('p').rows.every(row => row.id != null && row.name != null && row.note === null)).toBe(true);
        expect(result.tables.get('c').rows.every(row => row.pid === null)).toBe(true);
        expect(() => fixture(sql, { p: { enabled: true, count: 1 } }, { nullPercent: 101 })).toThrow(/0% and 100%/);
    });
    it('derives usable negative and large positive CHECK ranges', () => {
        const sql = 'CREATE TABLE t(id INT PRIMARY KEY, debt INT CHECK(debt <= -1), size INT CHECK(size >= 100000));';
        const result = fixture(sql, { t: { enabled: true, count: 30 } });
        expect(result.tables.get('t').rows.every(row => row.debt <= -1 && row.size >= 100000)).toBe(true);
    });
    it('does not silently replace an explicitly empty custom list', () => {
        const sql = "CREATE TABLE t(id INT PRIMARY KEY, state TEXT CHECK(state IN ('a','b')));";
        expect(() => fixture(sql, { t: { enabled: true, count: 1, columns: { state: { generator: 'choice', choices: [] } } } })).toThrow(/at least one custom value/);
    });
    it('generates the maximum 10,000-row batch with complete parent coverage', () => {
        const sql = 'CREATE TABLE p(id INT PRIMARY KEY); CREATE TABLE c(id INT PRIMARY KEY, pid INT NOT NULL REFERENCES p(id));';
        const result = generateSampleData({ sql, tables: { p: { enabled: true, count: 5000 }, c: { enabled: true, count: 5000 } } });
        expect(result.totalRows).toBe(10000); expect(result.previews).toHaveLength(2);
        expect(result.previews.every(preview => preview.count === 5000 && preview.rows.length === 5)).toBe(true);
    }, 60000);
    it('measures the SQL limit in UTF-8 bytes for non-ASCII custom data', () => {
        const sql = 'CREATE TABLE t(payload TEXT);';
        expect(() => generateSampleData({ sql, tables: { t: { enabled: true, count: 100, columns: { payload: { generator: 'choice', choices: ['界'.repeat(19000)] } } } } })).toThrow(/5 MB limit/);
    });
});

describe('native scalar validation before SQL emission', () => {
    it.each([
        ['SMALLINT', 32768], ['INT UNSIGNED', -1], ['INT', 1.5], ['INT', 'Ada'], ['INT', ''], ['BIGINT', Number.MAX_SAFE_INTEGER + 1],
        ['DECIMAL(4,2)', 100], ['DECIMAL(4,2)', Infinity], ['SMALLMONEY', 214749], ['MONEY', 1e16], ['REAL', 1e39], ['BOOLEAN', 'perhaps'], ['UUID', 'broken'], ['JSONB', '{broken}'],
        ['VARCHAR(2)', 'long'], ['DATE', '2024-02-30'], ['DATE', '2024-01-01 extra'], ['TIME', '24:00:00'], ['TIMESTAMP', '2024-01-01 12:99:00'], ['INET', '999.1.1.1'], ['INET', '1.2.3.4/99'],
    ])('rejects invalid %s value %s', (type, value) => {
        expect(() => normalizeSampleValue(value, { name: 'value', type }, 'postgres')).toThrow(/value:/);
    });
    it.each([
        ['SMALLINT', -32768], ['TINYINT', 127], ['INT UNSIGNED', 4294967295], ['BIGINT', Number.MAX_SAFE_INTEGER],
        ['DECIMAL(4,2)', 99.99], ['BOOLEAN', true], ['UUID', '4183442f-25c2-4cc1-9c69-bb2244a45459'], ['JSONB', '{"valid":true}'],
        ['VARCHAR(2)', '你好'], ['DATE', '2024-02-29'], ['TIME', '23:59:59'], ['TIMESTAMP', '2024-01-01 12:30:00'], ['INET', '10.0.0.1'], ['INET', '2001:db8::1'],
    ])('accepts valid %s value %s', (type, value) => {
        expect(() => normalizeSampleValue(value, { name: 'value', type }, 'postgres')).not.toThrow();
    });
    it('rounds positive and negative decimal ties consistently with SQL', () => {
        expect(normalizeSampleValue(1.005, { name: 'value', type: 'DECIMAL(8,2)' }, 'postgres')).toBe(1.01);
        expect(normalizeSampleValue(-1.005, { name: 'value', type: 'DECIMAL(8,2)' }, 'postgres')).toBe(-1.01);
    });
});
