/** Seeded scalar generators. The catalog is loaded only with the generation engine. */
import { inferSampleGenerator } from './sampleDataGenerators';
import { SAMPLE_DATA_CATALOG, SAMPLE_NAME_PROFILES } from './sampleDataCatalog';

const { companies: COMPANIES, places: PLACES, products: PRODUCTS, words: WORDS, jobTitles: JOB_TITLES, departments: DEPARTMENTS, streets: STREETS, descriptions: DESCRIPTIONS } = SAMPLE_DATA_CATALOG;

// SQL validators normalize numeric strings and UUID case too. This conservative
// key prevents fixture collisions before the authoritative engine checks them.
export const sampleValueKey = value => value == null ? null : String(value).toLowerCase();

export function createSampleRandom(seed) {
    let state = 2166136261;
    for (const char of String(seed)) state = Math.imul(state ^ char.charCodeAt(0), 16777619);
    return () => {
        state += 0x6d2b79f5;
        let value = Math.imul(state ^ state >>> 15, 1 | state);
        value ^= value + Math.imul(value ^ value >>> 7, 61 | value);
        return ((value ^ value >>> 14) >>> 0) / 4294967296;
    };
}

export function sampleValue({ column, config, ordinal, random, person, unique, hints, used = new Set(), spread = 0 }) {
    const pick = values => values[Math.floor(random() * values.length)];
    const mode = config.generator === 'auto' || !config.generator ? inferSampleGenerator(column) : config.generator;
    const number = ordinal + 1;
    const first = person.first;
    const last = person.last;
    const place = person.place;
    const name = column.name.toLowerCase();
    let value;
    if (mode === 'null') return null;
    if (mode === 'choice') {
        const values = Object.hasOwn(config, 'choices') ? config.choices : column.enumValues?.length ? column.enumValues : hints.choices;
        if (!values?.length) throw new Error(`${column.name}: enter at least one custom value (one per line).`);
        const index = ordinal % values.length;
        if (!unique) return values[index];
        for (let step = 0; step < values.length; step++) {
            const candidate = values[(index + step) % values.length];
            if (!used.has(sampleValueKey(candidate))) return candidate;
        }
        throw new Error(`${column.name}: its unique value domain is exhausted. Choose fewer rows or add more allowed values.`);
    }
    if (mode === 'uuid') {
        value = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, char => {
            const nibble = Math.floor(random() * 16);
            return (char === 'x' ? nibble : nibble & 3 | 8).toString(16);
        });
    } else if (mode === 'sequence') {
        const type = column.type.toUpperCase();
        if (/INT|SERIAL|NUMERIC|DECIMAL|NUMBER/.test(type)) {
            value = number;
            const max = /TINYINT/.test(type) ? /UNSIGNED/.test(type) ? 255 : 127 : /SMALLINT|INT2/.test(type) ? 32767 : Number.MAX_SAFE_INTEGER;
            if (!Number.isSafeInteger(value) || value > max) throw new Error(`${column.name}: the sequential ID exceeds the column's numeric range.`);
        } else {
            const length = type.match(/CHAR\s*\(\s*(\d+)\s*\)/)?.[1];
            value = length && Number(length) < 10 ? number.toString(36) : `item_${number}`;
            if (length && value.length > Number(length)) throw new Error(`${column.name}: the text ID domain is exhausted. Choose fewer rows or a longer column.`);
        }
    }
    else if (mode === 'integer' || mode === 'decimal') {
        const isInteger = mode === 'integer';
        const type = column.type.toUpperCase();
        const precision = type.match(/(?:DECIMAL|NUMERIC|NUMBER)\s*\(\s*(\d+)(?:\s*,\s*(\d+))?\s*\)/);
        const scale = isInteger ? 0 : precision ? Math.min(6, Number(precision[2] || 0)) : 2;
        const widthMax = precision ? Math.min(1e9, 10 ** (Number(precision[1]) - Number(precision[2] || 0)) - 10 ** -scale) : /TINYINT/.test(type) ? /UNSIGNED/.test(type) ? 255 : 127 : /SMALLINT|INT2/.test(type) ? 32767 : 1e9;
        const defaultMin = /age/.test(name) ? 18 : 0;
        const defaultMax = /age/.test(name) ? 80 : /percent|rating/.test(name) ? 100 : 1000;
        const automaticMin = hints.min ?? (hints.max != null && hints.max < defaultMin ? hints.max - 1000 : defaultMin);
        const automaticMax = hints.max ?? Math.max(defaultMax, automaticMin + 1000);
        const min = Math.max(config.min === '' || config.min == null ? automaticMin : Number(config.min), hints.min ?? -Infinity, /UNSIGNED/.test(type) ? 0 : -widthMax);
        const max = Math.min(config.max === '' || config.max == null ? automaticMax : Number(config.max), hints.max ?? Infinity, widthMax);
        const factor = 10 ** scale;
        const lo = Math.ceil(min * factor); const hi = Math.floor(max * factor);
        if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo > hi) throw new Error(`${column.name}: the numeric range has no values allowed by its type and CHECK constraints.`);
        const domain = hi - lo + 1;
        if (unique) {
            const origin = (Math.floor(spread * domain) + ordinal) % domain;
            for (let step = 0; step <= Math.min(used.size, domain - 1); step++) {
                const candidate = (lo + (origin + step) % domain) / factor;
                if (!used.has(sampleValueKey(candidate))) { value = candidate; break; }
            }
            if (value === undefined) throw new Error(`${column.name}: its unique numeric range is exhausted. Widen the range or choose fewer rows.`);
        } else {
            // Include bounds in addition to random interiors so small fixtures
            // exercise low/high values rather than clustering around the middle.
            value = (ordinal % 10 === 0 ? lo : ordinal % 10 === 1 ? hi : lo + Math.floor(random() * domain)) / factor;
        }
    } else if (mode === 'boolean') value = random() >= 0.5;
    else if (['date', 'datetime', 'time'].includes(mode)) {
        const start = Date.parse(config.startDate || '2024-01-01');
        const end = Date.parse(config.endDate || '2025-12-31');
        if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) throw new Error(`${column.name}: choose a valid date range.`);
        const unit = mode === 'date' ? 86400000 : 1000;
        const domain = mode === 'time' ? 86400 : Math.floor((end + 86400000 - start) / unit);
        const format = offset => {
            const iso = new Date((mode === 'time' ? 0 : start) + offset * unit).toISOString();
            return mode === 'date' ? iso.slice(0, 10) : mode === 'time' ? iso.slice(11, 19) : iso.slice(0, 19).replace('T', ' ');
        };
        if (unique) {
            const origin = (Math.floor(spread * domain) + ordinal) % domain;
            for (let step = 0; step <= Math.min(used.size, domain - 1); step++) {
                const candidate = format((origin + step) % domain);
                if (!used.has(sampleValueKey(candidate))) { value = candidate; break; }
            }
            if (value === undefined) throw new Error(`${column.name}: its unique date/time range is exhausted. Widen the range or choose fewer rows.`);
        } else value = format(ordinal % 10 === 0 ? 0 : ordinal % 10 === 1 ? domain - 1 : Math.floor(random() * domain));
    } else if (mode === 'json') value = JSON.stringify({ id: number, label: pick(WORDS), active: random() >= 0.5 });
    else if (mode === 'name') value = person.fullName;
    else if (mode === 'firstName') value = first;
    else if (mode === 'lastName') value = last;
    else if (mode === 'email') value = `${person.firstHandle}.${person.lastHandle}.${number}@example.com`;
    else if (mode === 'username') value = `${person.firstHandle.replace(/\./g, '_')}_${person.lastHandle}${number}`;
    else if (mode === 'phone') value = `+1-202-555-${String(number % 10000).padStart(4, '0')}`;
    else if (mode === 'company') value = pick(COMPANIES);
    else if (mode === 'jobTitle') value = pick(JOB_TITLES);
    else if (mode === 'department') value = pick(DEPARTMENTS);
    else if (mode === 'address') value = `${number + 100} ${pick(STREETS)} Street`;
    else if (mode === 'city') value = place[0];
    else if (mode === 'country') value = place[1];
    else if (mode === 'countryCode') value = place[3];
    else if (mode === 'currency') value = place[4];
    else if (mode === 'latitude') value = Number((place[5] + (random() - 0.5) * 0.005).toFixed(6));
    else if (mode === 'longitude') value = Number((place[6] + (random() - 0.5) * 0.005).toFixed(6));
    else if (mode === 'postal') value = place[2];
    else if (mode === 'product') value = `${pick(WORDS).replace(/^./, char => char.toUpperCase())} ${pick(PRODUCTS)}`;
    else if (mode === 'sku') value = `SKU-${String(number).padStart(8, '0')}`;
    else if (mode === 'slug') value = `${pick(WORDS)}-${pick(WORDS)}-${number}`;
    else if (mode === 'status') value = ['pending', 'active', 'inactive', 'completed', 'cancelled'][ordinal % 5];
    else if (mode === 'color') value = '#' + Math.floor(random() * 16777216).toString(16).padStart(6, '0');
    else if (mode === 'ip') value = `10.${Math.floor(number / 65536) % 256}.${Math.floor(number / 256) % 256}.${number % 254 + 1}`;
    else if (mode === 'ipv6') value = `2001:db8:${Math.floor(number / 65536).toString(16)}::${(number % 65536).toString(16)}`;
    else if (mode === 'url') value = `https://example.com/items/${number}`;
    else value = `${pick(DESCRIPTIONS)} (sample ${number})`;
    if (typeof value === 'string') {
        const limit = column.type.match(/(?:VAR)?(?:N?CHAR|CHARACTER(?: VARYING)?)\s*\(\s*(\d+)\s*\)/i)?.[1];
        // Preserve uniqueness after truncation. Domains/enums and fixed-format UUIDs
        // are never rewritten: an incompatible schema must produce a diagnostic.
        const suffix = unique && !['uuid', 'email', 'username', 'sequence', 'ip', 'ipv6', 'phone', 'sku', 'countryCode', 'currency', 'color', 'status', 'date', 'time', 'datetime', 'json'].includes(mode) ? `_${number}` : '';
        value = limit ? value.slice(0, Math.max(0, Number(limit) - suffix.length)) + suffix : value + suffix;
        if (limit && value.length > Number(limit)) throw new Error(`${column.name}: the text length is too small for unique values. Choose fewer rows or another generator.`);
    }
    return value;
}

export function samplePerson(random, locale = 'en', ordinal = 0, spread = 0) {
    const pick = values => values[Math.floor(random() * values.length)];
    // An unknown/legacy caller falls back to the general English dictionary.
    const profile = Object.hasOwn(SAMPLE_NAME_PROFILES, locale) ? SAMPLE_NAME_PROFILES[locale] : SAMPLE_NAME_PROFILES.en;
    const [first, firstHandle] = pick(profile.firstNames);
    const [last, lastHandle] = pick(profile.lastNames);
    const placeIndex = (Math.floor(spread * PLACES.length) + ordinal) % PLACES.length;
    return {
        first, last, firstHandle, lastHandle,
        fullName: profile.familyFirst ? `${last}${profile.separator}${first}` : `${first}${profile.separator}${last}`,
        place: PLACES[placeIndex],
    };
}
