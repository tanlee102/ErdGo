/** Share the layout engine, but download and construct it only when layout is requested. */
let engine;

export async function layoutGraph(graph) {
    engine ??= import('elkjs/lib/elk.bundled.js').then(({ default: ELK }) => new ELK()).catch(error => {
        engine = null;
        throw error;
    });
    return (await engine).layout(graph);
}
