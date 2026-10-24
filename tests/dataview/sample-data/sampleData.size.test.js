import { expect, it, vi } from 'vitest';
import { generateSampleData, SAMPLE_DATA_LIMITS } from '@/features/data-view/lib/sampleData';

// Exercise the byte boundary without repeatedly parsing multi-megabyte strings.
// Production retains its real 5 MB limit; only this isolated module uses 1 KB.
vi.mock('@/features/data-view/lib/sampleDataSchema', async importOriginal => {
    const actual = await importOriginal();
    return { ...actual, SAMPLE_DATA_LIMITS: { ...actual.SAMPLE_DATA_LIMITS, bytes: 1024 } };
});

it('includes the UTF-8 header and separators in the final SQL size limit', () => {
    const options = {
        sql: 'CREATE TABLE t(payload TEXT);', seed: '界'.repeat(80),
        tables: { t: { enabled: true, count: 1, columns: { payload: { generator: 'choice', choices: ['x'] } } } },
    };
    const probe = generateSampleData(options);
    const length = SAMPLE_DATA_LIMITS.bytes - new TextEncoder().encode(probe.sql).byteLength + 2;
    options.tables.t.columns.payload.choices = ['x'.repeat(length)];
    expect(() => generateSampleData(options)).toThrow(/5 MB limit/);
});
