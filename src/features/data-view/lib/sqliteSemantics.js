/**
 * SQLite storage-class, affinity, and STRICT-table semantics.
 *
 * These rules intentionally do not use JavaScript's loose equality or locale
 * comparison: both differ from SQLite for numeric text and BINARY collation.
 * Keep changes aligned with native SQLite semantics.
 */
export function sqliteColumnAffinity(type) {
    const normalized = String(type || '').toUpperCase();
    if (/CHAR|CLOB|TEXT/.test(normalized)) return 'text';
    if (/INT|REAL|FLOA|DOUB|NUMERIC|DECIMAL|BOOLEAN|DATE|TIME/.test(normalized)) return 'numeric';
    return null;
}

export function sqliteNumericValue(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'boolean') return Number(value);
    if (typeof value !== 'string') return null;
    const normalized = value.trim();
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(normalized)) return null;
    const numeric = Number(normalized);
    return Number.isFinite(numeric) ? numeric : null;
}

export function sqliteBinaryCompare(left, right) {
    const leftChars = Array.from(left);
    const rightChars = Array.from(right);
    const length = Math.min(leftChars.length, rightChars.length);
    for (let index = 0; index < length; index++) {
        const difference = leftChars[index].codePointAt(0) - rightChars[index].codePointAt(0);
        if (difference !== 0) return difference;
    }
    return leftChars.length - rightChars.length;
}

export function sqliteStorageCompare(left, right) {
    const normalize = (value) => typeof value === 'boolean' ? Number(value) : value;
    const first = normalize(left);
    const second = normalize(right);
    if (first === second) return 0;
    if (typeof first === 'number' && typeof second === 'number') return first - second;
    if (typeof first === 'string' && typeof second === 'string') return sqliteBinaryCompare(first, second);
    const rank = (value) => {
        if (value == null) return 0;
        if (typeof value === 'number') return 1;
        if (typeof value === 'string') return 2;
        return 3;
    };
    return rank(first) - rank(second);
}

export function sqliteStrictTypeFamily(type) {
    const normalized = String(type || '').trim().toUpperCase();
    if (normalized === 'INT' || normalized === 'INTEGER') return 'integer';
    if (normalized === 'REAL') return 'real';
    if (normalized === 'TEXT') return 'text';
    if (normalized === 'BLOB') return 'blob';
    if (normalized === 'ANY') return 'any';
    return null;
}

export function isSqliteBlobValue(value) {
    return value instanceof Uint8Array || value instanceof ArrayBuffer;
}

export function sqliteStorageClassLabel(value) {
    if (value === null || value === undefined) return 'NULL';
    if (isSqliteBlobValue(value)) return 'BLOB';
    if (typeof value === 'boolean') return 'INTEGER';
    if (typeof value === 'number') return Number.isInteger(value) ? 'INTEGER' : 'REAL';
    if (typeof value === 'string') {
        const numeric = sqliteNumericValue(value);
        if (numeric != null) return Number.isInteger(numeric) ? 'INTEGER' : 'REAL';
        return 'TEXT';
    }
    return 'BLOB';
}
