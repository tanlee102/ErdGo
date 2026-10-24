import { describe, expect, it } from 'vitest';
import { generateSampleData, inspectSampleSchema } from '@/features/data-view/lib/sampleData';
import { prepareSampleSchema } from '@/features/data-view/lib/sampleDataSchema';

const SQL = 'CREATE TABLE p(id INT PRIMARY KEY); INSERT INTO p VALUES(10); CREATE TABLE c(id INT PRIMARY KEY, pid INT REFERENCES p(id));';
const options = { sql: SQL, seed: 'prepared', tables: { p: { enabled: true, count: 8 }, c: { enabled: true, count: 30 } } };

describe('worker-local sample preparation', () => {
    it('reuses inspected SQL once without accumulating rows across regeneration', () => {
        const prepared = prepareSampleSchema(SQL);
        expect(prepared.model).toEqual(inspectSampleSchema(SQL));
        const fresh = generateSampleData(options);
        expect(generateSampleData(options, undefined, prepared)).toEqual(fresh);
        expect(prepared.consumed).toBe(true);
        expect(generateSampleData(options, undefined, prepared)).toEqual(fresh);
    });
    it.each([
        { sql: SQL + ' INSERT INTO p VALUES(11);' },
        { dialect: 'sqlite' },
    ])('reinspects changed SQL or dialect rather than consuming stale preparation', patch => {
        const prepared = prepareSampleSchema(SQL);
        const changed = { ...options, ...patch };
        expect(generateSampleData(changed, undefined, prepared)).toEqual(generateSampleData(changed));
        expect(prepared.consumed).toBe(false);
    });
});
