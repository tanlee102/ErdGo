import { expect, it } from 'vitest';
import { findConnectorDropField } from '@/lib/erd-renderer/endpointReconnect';

it('hits visible field rows, including zoom-adjusted edge tolerance, but excludes headers and empty space', () => {
    const table = { name: 'users', x: 100, y: 100, width: 100, height: 86, columns: [{ name: 'id' }, { name: 'name' }] };
    expect(findConnectorDropField([table], 100, 70)).toBeNull();
    expect(findConnectorDropField([table], 100, 100)).toMatchObject({ table: 'users', column: 'id', rowIndex: 0 });
    expect(findConnectorDropField([table], 155, 120)).toBeNull();
    expect(findConnectorDropField([table], 155, 120, { edgeMargin: 10 })).toMatchObject({ column: 'name' });
    expect(findConnectorDropField([table], 100, 150)).toBeNull();
});

it('uses compact-mode columns and gives the topmost table priority', () => {
    const table = { name: 'a', x: 100, y: 100, width: 100, height: 58, columns: [{ name: 'hidden' }, { name: 'id' }] };
    expect(findConnectorDropField([table, { ...table, name: 'b' }], 100, 110, { getColumns: (t) => [t.columns[1]] })).toMatchObject({ table: 'b', column: 'id', rowIndex: 0 });
    expect(findConnectorDropField([table, { ...table, name: 'header', y: 130 }], 100, 110)).toBeNull();
});
