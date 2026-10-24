import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.resetModules(); });

it('inspects without loading dictionaries, reuses preparation and returns clean repeated batches', async () => {
    const messages = [];
    const worker = { postMessage: message => messages.push(structuredClone(message)) };
    vi.stubGlobal('self', worker);
    const schema = await import('@/features/data-view/lib/sampleDataSchema');
    const prepare = vi.spyOn(schema, 'prepareSampleSchema');
    await import('@/features/data-view/lib/sampleData.worker');
    const sql = 'CREATE TABLE people(id INT PRIMARY KEY, name TEXT, email TEXT UNIQUE);';
    await worker.onmessage({ data: { type: 'inspect', sql, dialect: 'auto' } });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ type: 'schema', model: { errors: [], tables: [{ name: 'people', existingRows: 0 }] } });
    expect(prepare).toHaveBeenCalledTimes(1);
    const input = { type: 'generate', sql, dialect: 'auto', tables: { people: { enabled: true, count: 12 } } };
    await worker.onmessage({ data: input });
    const first = messages.at(-1);
    expect(first).toMatchObject({ type: 'result', result: { totalRows: 12 } });
    expect(prepare).toHaveBeenCalledTimes(1);
    await worker.onmessage({ data: input });
    expect(messages.at(-1)).toEqual(first);
    expect(prepare).toHaveBeenCalledTimes(2);
    await worker.onmessage({ data: { ...input, tables: {} } });
    expect(messages.at(-1)).toMatchObject({ type: 'error', message: 'Select at least one table.' });
});
