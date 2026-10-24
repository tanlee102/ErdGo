/** Native scalar guards supplement Data View's constraint checks before fixture SQL is emitted. */
export function normalizeSampleValue(value, column, dialect) {
    if (value == null) return null;
    const type = column.type.toUpperCase().trim();
    const fail = message => { throw new Error(`${column.name}: ${message}`); };
    if (column.isEnum) return value;
    if (/^(BOOL(?:EAN)?|BIT(?:\s*\(1\))?)$/.test(type)) {
        if ([true, 1, '1', 'true', 'TRUE'].includes(value)) return true;
        if ([false, 0, '0', 'false', 'FALSE'].includes(value)) return false;
        fail('choose a Boolean generator or values true/false.');
    }
    if (/^(?:TINYINT|SMALLINT|MEDIUMINT|INT(?:EGER)?|BIGINT|INT[248]|SERIAL|BIGSERIAL|SMALLSERIAL)\b/.test(type)) {
        const number = Number(value);
        const bits = /TINYINT/.test(type) ? 8 : /SMALLINT|INT2|SMALLSERIAL/.test(type) ? 16 : /MEDIUMINT/.test(type) ? 24 : /BIGINT|INT8|BIGSERIAL/.test(type) ? 53 : 32;
        const unsigned = /UNSIGNED/.test(type) || dialect === 'mssql' && /TINYINT/.test(type);
        const min = unsigned ? 0 : bits === 53 ? -Number.MAX_SAFE_INTEGER : -(2 ** (bits - 1));
        const max = bits === 53 ? Number.MAX_SAFE_INTEGER : 2 ** (bits - (unsigned ? 0 : 1)) - 1;
        if (!String(value).trim() || !Number.isSafeInteger(number) || number < min || number > max) fail(`value is outside the ${column.type} integer range. Change the generator or range.`);
        return number;
    }
    if (/^(DECIMAL|NUMERIC|NUMBER|FLOAT|REAL|DOUBLE(?: PRECISION)?|MONEY|SMALLMONEY)\b/.test(type)) {
        const number = Number(value);
        if (!String(value).trim() || !Number.isFinite(number)) fail('choose a numeric generator or numeric custom values.');
        if (/^SMALLMONEY\b/.test(type) && (number < -214748.3648 || number > 214748.3647)) fail('value exceeds SMALLMONEY range.');
        // The native boundary rounds upward in JavaScript. Reject that rounded
        // endpoint too, rather than serializing a decimal above MONEY's maximum.
        const moneyBoundary = Number('922337203685477.5807');
        if (/^MONEY\b/.test(type) && Math.abs(number) >= moneyBoundary) fail('value exceeds the safely representable MONEY range.');
        if (/^REAL\b/.test(type) && Math.abs(number) > 3.402823466e38) fail('value exceeds REAL range.');
        const precision = type.match(/^(?:DECIMAL|NUMERIC|NUMBER)\s*\(\s*(\d+)(?:\s*,\s*(\d+))?\s*\)/);
        if (!precision) return number;
        const scale = Number(precision[2] || 0);
        // Shift the decimal exponent as text so 1.005 rounds to 1.01 rather
        // than inheriting the binary-float product 100.49999999999999.
        const safeScale = Math.min(scale, 12);
        const [coefficient, exponent = '0'] = String(Math.abs(number)).split('e');
        const shifted = Math.round(Number(`${coefficient}e${Number(exponent) + safeScale}`));
        const [roundedCoefficient, roundedExponent = '0'] = String(shifted).split('e');
        const rounded = Math.sign(number) * Number(`${roundedCoefficient}e${Number(roundedExponent) - safeScale}`);
        if (Math.abs(rounded) >= 10 ** (Number(precision[1]) - scale)) fail(`value exceeds ${column.type} precision. Use a smaller range.`);
        return rounded;
    }
    const text = String(value);
    if (/^(UUID|UNIQUEIDENTIFIER)$/.test(type)) {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text)) fail('choose the UUID generator or valid UUID custom values.');
        return text;
    }
    if (/^JSONB?$/.test(type)) {
        try { JSON.parse(text); } catch { fail('choose the JSON generator or valid JSON custom values.'); }
        return text;
    }
    if (/^(DATE|TIME(?:STAMP)?|DATETIME[2]?|SMALLDATETIME|DATETIMEOFFSET)\b/.test(type)) {
        const dateOnly = /^DATE$/.test(type);
        const timeOnly = /^TIME(?:\s*\(|\s|$)/.test(type);
        const date = text.slice(0, 10);
        if (dateOnly && !/^\d{4}-\d{2}-\d{2}$/.test(text)) fail('use a date in YYYY-MM-DD format.');
        if (!timeOnly && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date)) fail('choose a date generator or a valid ISO date.');
        const time = timeOnly ? text : text.slice(11);
        if (!dateOnly && !/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/.test(time)) fail('choose a time or date-and-time generator with valid hours, minutes and seconds.');
        return text;
    }
    if (/^(INET|CIDR)$/.test(type)) {
        const address = text.split('/')[0];
        if (address.includes(':')) {
            try { new URL(`http://[${address}]/`); } catch { fail('use a valid IP address.'); }
        } else if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(address) || address.split('.').some(part => Number(part) > 255)) fail('use a valid IP address.');
        if (text.includes('/') && (!/^\d+$/.test(text.split('/')[1]) || Number(text.split('/')[1]) > (address.includes(':') ? 128 : 32))) fail('use a valid network prefix length.');
        return text;
    }
    const length = type.match(/(?:VAR)?(?:N?CHAR|CHARACTER(?: VARYING)?)\s*\(\s*(\d+)\s*\)/)?.[1] ?? (/^(N?CHAR|CHARACTER)$/.test(type) ? 1 : null);
    const textLength = dialect === 'mssql' && /^N/.test(type) ? text.length : [...text].length;
    if (length && textLength > Number(length)) fail(`the value exceeds ${column.type} length. Choose shorter custom values or a different generator.`);
    return text;
}
