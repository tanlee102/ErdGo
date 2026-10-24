import { describe, expect, it } from 'vitest';
import { generateSampleData } from '@/features/data-view/lib/sampleData';

// Verify emitted SQL independently of the app's validator whenever Node provides SQLite.
let DatabaseSync;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch { /* Optional native runtime. */ }

describe.skipIf(!DatabaseSync)('generated fixtures in native SQLite', () => {
    it('executes exclusive nullable references without violating CHECK or FK constraints', () => {
        const sql = 'PRAGMA foreign_keys=ON; CREATE TABLE p(id INTEGER PRIMARY KEY); CREATE TABLE v(id INTEGER PRIMARY KEY); CREATE TABLE c(id INTEGER PRIMARY KEY, post_id INTEGER REFERENCES p(id), video_id INTEGER REFERENCES v(id), CHECK((post_id IS NOT NULL AND video_id IS NULL) OR (post_id IS NULL AND video_id IS NOT NULL)));';
        const result = generateSampleData({ sql, dialect: 'sqlite', nullPercent: 100, tables: { p: { enabled: true, count: 5 }, v: { enabled: true, count: 5 }, c: { enabled: true, count: 20 } } });
        const db = new DatabaseSync(':memory:');
        try {
            db.exec(sql); db.exec(result.sql);
            expect(db.prepare('SELECT COUNT(*) AS n FROM c WHERE (post_id IS NULL) = (video_id IS NULL)').get().n).toBe(0);
            expect(db.prepare('SELECT COUNT(*) AS n FROM c').get().n).toBe(20);
            expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
        } finally { db.close(); }
    });
    it.each(['zh-CN', 'ja-JP', 'ko-KR', 'ar-SA', 'vi'])('executes native-script %s names with unique ASCII handles', locale => {
        const sql = 'CREATE TABLE people(id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, username TEXT UNIQUE NOT NULL) STRICT;';
        const result = generateSampleData({ sql, dialect: 'sqlite', locale, tables: { people: { enabled: true, count: 50 } } });
        const db = new DatabaseSync(':memory:');
        try {
            db.exec(sql); db.exec(result.sql);
            const rows = db.prepare('SELECT name,email,username FROM people').all();
            expect(rows).toHaveLength(50);
            expect(new Set(rows.map(row => row.email)).size).toBe(50);
            for (const row of rows) {
                expect(row.name).toMatch(/\P{ASCII}/u);
                expect(row.email).toMatch(/^[a-z]+(?:\.[a-z]+)*\.\d+@example\.com$/);
                expect(row.username).toMatch(/^[a-z_.]+\d+$/);
            }
        } finally { db.close(); }
    });
    it('fills every combination of independent composite-parent and tag keys', () => {
        const sql = `PRAGMA foreign_keys=ON;
            CREATE TABLE people(tenant INTEGER NOT NULL, id INTEGER NOT NULL, PRIMARY KEY(tenant,id));
            CREATE TABLE tags(id INTEGER PRIMARY KEY);
            CREATE TABLE links(tenant INTEGER NOT NULL, person_id INTEGER NOT NULL, tag_id INTEGER NOT NULL REFERENCES tags(id), FOREIGN KEY(tenant,person_id) REFERENCES people(tenant,id), PRIMARY KEY(tenant,person_id,tag_id));`;
        const result = generateSampleData({ sql, dialect: 'sqlite', tables: { people: { enabled: true, count: 6 }, tags: { enabled: true, count: 4 }, links: { enabled: true, count: 24 } } });
        const db = new DatabaseSync(':memory:');
        try {
            db.exec(sql); db.exec(result.sql);
            expect(db.prepare('SELECT COUNT(*) AS n FROM links').get().n).toBe(24);
            expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
            expect(db.prepare('SELECT COUNT(*) AS n FROM people CROSS JOIN tags WHERE NOT EXISTS(SELECT 1 FROM links WHERE links.tenant=people.tenant AND links.person_id=people.id AND links.tag_id=tags.id)').get().n).toBe(0);
        } finally { db.close(); }
    });
    it('executes linked composite keys, computed values, choices, escaping and existing rows', () => {
        const sql = `PRAGMA foreign_keys=ON;
            CREATE TABLE accounts(tenant INTEGER NOT NULL, id INTEGER NOT NULL, email TEXT UNIQUE NOT NULL, PRIMARY KEY(tenant,id)) STRICT;
            INSERT INTO accounts VALUES(1,1,'existing@example.com');
            CREATE TABLE orders(id INTEGER PRIMARY KEY AUTOINCREMENT, tenant INTEGER NOT NULL, account_id INTEGER NOT NULL, amount REAL CHECK(amount BETWEEN 1 AND 99), total REAL GENERATED ALWAYS AS(amount*2) STORED, state TEXT CHECK(state IN ('pending','paid')), note TEXT, FOREIGN KEY(tenant,account_id) REFERENCES accounts(tenant,id)) STRICT;`;
        const result = generateSampleData({ sql, tables: { accounts: { enabled: true, count: 30 }, orders: { enabled: true, count: 100, columns: { note: { generator: 'choice', choices: ["O'Brien", '你好', 'hello; --'] } } } } });
        const db = new DatabaseSync(':memory:');
        try {
            db.exec(sql); db.exec(result.sql);
            expect(db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n).toBe(31);
            expect(db.prepare('SELECT COUNT(*) AS n FROM orders').get().n).toBe(100);
            expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
            expect(db.prepare('SELECT COUNT(*) AS n FROM orders WHERE total != amount*2').get().n).toBe(0);
            expect(db.prepare("SELECT COUNT(*) AS n FROM orders WHERE note = ?").get("O'Brien").n).toBeGreaterThan(0);
        } finally { db.close(); }
    });
});
