/** Inspection/generation stay off the UI thread. Catalogs load only on Generate. */
let prepared;

self.onmessage = async event => {
    try {
        if (event.data.type === 'inspect') {
            const { prepareSampleSchema } = await import('./sampleDataSchema').catch(() => { throw new Error('The schema inspector could not load. Check your connection and reopen the generator.'); });
            prepared = prepareSampleSchema(event.data.sql, event.data.dialect);
            self.postMessage({ type: 'schema', model: prepared.model });
            return;
        }
        const { generateSampleData } = await import('./sampleData').catch(() => { throw new Error('The generator data could not load. Check your connection and try again.'); });
        const context = prepared;
        prepared = null;
        const result = generateSampleData(event.data, progress => self.postMessage({ type: 'progress', progress }), context);
        self.postMessage({ type: 'result', result });
    } catch (error) {
        self.postMessage({ type: 'error', message: error.message || 'Sample data could not be generated.' });
    }
};
