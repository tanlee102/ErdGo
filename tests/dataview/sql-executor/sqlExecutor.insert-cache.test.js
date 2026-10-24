/** Opted-in append sessions retain the ordinary executor's mutation semantics. */
import { describe, expect, it } from 'vitest';
import { createSqlExecutor } from '@/features/data-view/lib/sqlExecutor';

function compareExecutors(dialect, scripts) {
    const ordinary = createSqlExecutor({ dialect });
    const cached = createSqlExecutor({ dialect, cacheInsertConstraints: true });
    for (const sql of scripts) {
        const expected = ordinary.execute(sql);
        const actual = cached.execute(sql);
        expect(actual.tables, sql).toEqual(expected.tables);
        const diagnostics = result => result.log.map(({ type, message, position }) => ({ type, message, position }));
        expect(diagnostics(actual), sql).toEqual(diagnostics(expected));
    }
    return cached;
}

describe.each(['postgres', 'mysql', 'mssql', 'sqlite'])('append constraint indexes in %s', dialect => {
    it('enforces primary, single and composite unique keys across calls and atomic failures', () => {
        const executor = compareExecutors(dialect, [
            'CREATE TABLE t(id INT PRIMARY KEY, label VARCHAR(30) UNIQUE, a INT, b INT, UNIQUE(a,b));',
            "INSERT INTO t VALUES(1,'one',1,1);",
            // The first tuple stages keys; the second rejects the whole statement.
            "INSERT INTO t VALUES(2,'two',2,2),(1,'other',3,3);",
            "INSERT INTO t VALUES(2,'two',2,2);",
            "INSERT INTO t VALUES(3,'two',3,3);",
            "INSERT INTO t VALUES(3,'three',2,2);",
            "INSERT INTO t VALUES(3,'three',3,3);",
            'INSERT INTO t VALUES(4,NULL,4,NULL);',
            'INSERT INTO t VALUES(5,NULL,4,NULL);',
        ]);
        expect(executor.tables.get('t').rows.slice(0, 3).map(row => row.id)).toEqual([1, 2, 3]);
        // SQL Server also rejects both repeated NULL unique keys in the last row.
        expect(executor.executionLog.filter(entry => entry.type === 'error')).toHaveLength(dialect === 'mssql' ? 5 : 3);
    });
    it('refreshes keys after updates, deletions and schema replacement', () => {
        const executor = compareExecutors(dialect, [
            'CREATE TABLE t(id INT PRIMARY KEY, code INT UNIQUE); INSERT INTO t VALUES(1,10);',
            'INSERT INTO t VALUES(2,20);',
            'UPDATE t SET code = 30 WHERE id = 1;',
            'INSERT INTO t VALUES(3,10);',
            'INSERT INTO t VALUES(4,30);',
            'DELETE FROM t WHERE id = 2;',
            'INSERT INTO t VALUES(2,20);',
            'DROP TABLE t; CREATE TABLE t(id INT PRIMARY KEY, code INT UNIQUE);',
            'INSERT INTO t VALUES(1,10);',
        ]);
        expect(executor.tables.get('t').rows).toEqual([{ id: 1, code: 10 }]);
        expect(executor.executionLog.filter(entry => entry.type === 'error')).toHaveLength(1);
    });
    it('refreshes rolled-back keys and revalidates foreign keys and checks', () => {
        const executor = compareExecutors(dialect, [
            ...(dialect === 'sqlite' ? ['PRAGMA foreign_keys = ON;'] : []),
            'CREATE TABLE p(id INT PRIMARY KEY); INSERT INTO p VALUES(1); CREATE TABLE c(id INT PRIMARY KEY, pid INT REFERENCES p(id), amount INT CHECK(amount >= 0));',
            'INSERT INTO c VALUES(1,1,1);',
            'BEGIN; INSERT INTO c VALUES(2,1,2); ROLLBACK;',
            'INSERT INTO c VALUES(2,1,2);',
            'INSERT INTO c VALUES(3,99,3);',
            'INSERT INTO c VALUES(3,1,-1);',
            'INSERT INTO c VALUES(3,1,3);',
        ]);
        expect(executor.tables.get('c').rows.map(row => row.id)).toEqual([1, 2, 3]);
        expect(executor.executionLog.filter(entry => entry.type === 'error')).toHaveLength(2);
    });
    it('tracks independent parent keys through append, delete and rollback', () => {
        const executor = compareExecutors(dialect, [
            ...(dialect === 'sqlite' ? ['PRAGMA foreign_keys = ON;'] : []),
            'CREATE TABLE p(id INT PRIMARY KEY, code VARCHAR(30) UNIQUE); CREATE TABLE c(id INT PRIMARY KEY, pid INT REFERENCES p(id), code VARCHAR(30) REFERENCES p(code));',
            "INSERT INTO p VALUES(1,'A'),(2,'B'); INSERT INTO c VALUES(1,1,'B');",
            "INSERT INTO c VALUES(2,2,'A');",
            "INSERT INTO p VALUES(3,'C'); INSERT INTO c VALUES(3,3,'C');",
            "INSERT INTO p VALUES(4,'D'); INSERT INTO c VALUES(4,1,'A'); DELETE FROM p WHERE id=4;",
            "INSERT INTO c VALUES(5,4,'D');",
            "BEGIN; INSERT INTO p VALUES(4,'D'); INSERT INTO c VALUES(5,4,'D'); ROLLBACK;",
            "INSERT INTO c VALUES(5,4,'D');",
            "INSERT INTO c VALUES(5,1,'C');",
        ]);
        expect(executor.tables.get('c').rows.map(row => row.id)).toEqual([1, 2, 3, 4, 5]);
        expect(executor.tables.get('p').rows.map(row => row.id)).toEqual([1, 2, 3]);
        // Both the id and code references are missing in each rejected row.
        expect(executor.executionLog.filter(entry => entry.type === 'error')).toHaveLength(4);
    });
    it('keeps composite key boundaries and nullable MATCH SIMPLE references', () => {
        const executor = compareExecutors(dialect, [
            ...(dialect === 'sqlite' ? ['PRAGMA foreign_keys = ON;'] : []),
            'CREATE TABLE p(a VARCHAR(30), b VARCHAR(30), PRIMARY KEY(a,b)); CREATE TABLE c(id INT PRIMARY KEY, a VARCHAR(30), b VARCHAR(30), FOREIGN KEY(a,b) REFERENCES p(a,b));',
            "INSERT INTO p VALUES('a,b','c'),('a','d'); INSERT INTO c VALUES(1,'a,b','c');",
            "INSERT INTO c VALUES(2,'a','b,c');",
            "INSERT INTO c VALUES(2,'a','d'); INSERT INTO c VALUES(3,'missing',NULL);",
        ]);
        expect(executor.tables.get('c').rows.map(row => row.id)).toEqual([1, 2, 3]);
        expect(executor.executionLog.filter(entry => entry.type === 'error')).toHaveLength(1);
    });
    it('keeps staged forward/self references valid within an atomic INSERT', () => {
        const executor = compareExecutors(dialect, [
            ...(dialect === 'sqlite' ? ['PRAGMA foreign_keys = ON;'] : []),
            'CREATE TABLE staff(id INT PRIMARY KEY, manager_id INT REFERENCES staff(id));',
            'INSERT INTO staff VALUES(1,2),(2,NULL);',
            'INSERT INTO staff VALUES(3,3);',
            'INSERT INTO staff VALUES(4,99);',
        ]);
        expect(executor.tables.get('staff').rows.map(row => row.id)).toEqual([1, 2, 3]);
        expect(executor.executionLog.filter(entry => entry.type === 'error')).toHaveLength(1);
    });
});

it('retains SQLite parent affinity for text-backed foreign keys', () => {
    const executor = compareExecutors('sqlite', [
        'PRAGMA foreign_keys=ON; CREATE TABLE p(id INTEGER PRIMARY KEY); CREATE TABLE c(id INTEGER PRIMARY KEY, pid TEXT REFERENCES p(id));',
        "INSERT INTO p VALUES(1); INSERT INTO c VALUES(1,'001');",
        "INSERT INTO c VALUES(2,'01');",
    ]);
    expect(executor.tables.get('c').rows).toHaveLength(2);
    expect(executor.executionLog.filter(entry => entry.type === 'error')).toEqual([]);
});

it('validates PostgreSQL deferred references at COMMIT without caching staged keys', () => {
    const executor = compareExecutors('postgres', [
        'CREATE TABLE p(id INT PRIMARY KEY); CREATE TABLE c(id INT PRIMARY KEY, pid INT REFERENCES p(id) DEFERRABLE INITIALLY DEFERRED);',
        'BEGIN; INSERT INTO c VALUES(1,1); INSERT INTO p VALUES(1); COMMIT;',
        'BEGIN; INSERT INTO c VALUES(2,99); COMMIT;',
    ]);
    expect(executor.tables.get('c').rows).toEqual([{ id: 1, pid: 1 }]);
    expect(executor.executionLog.filter(entry => entry.type === 'error')).toHaveLength(1);
});
