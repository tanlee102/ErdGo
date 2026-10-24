/** Lightweight generator labels and inference; safe to load before starting a worker. */
export const SAMPLE_DATA_LIMITS = Object.freeze({ rowsPerTable: 5000, totalRows: 10000, cells: 150000, bytes: 5 * 1024 * 1024 });

// Country labels are UI metadata; the actual name pools stay in the worker catalog.
export const SAMPLE_NAME_DICTIONARIES = [
    ['en', 'English (general)'],
    ['en-AU', 'Australia'], ['pt-BR', 'Brazil'], ['en-CA', 'Canada'], ['zh-CN', 'China'],
    ['ar-EG', 'Egypt'], ['fr-FR', 'France'], ['de-DE', 'Germany'], ['en-IN', 'India'],
    ['id-ID', 'Indonesia'], ['it-IT', 'Italy'], ['ja-JP', 'Japan'], ['es-MX', 'Mexico'],
    ['nl-NL', 'Netherlands'], ['en-NG', 'Nigeria'], ['en-PH', 'Philippines'], ['pl-PL', 'Poland'],
    ['pt-PT', 'Portugal'], ['ar-SA', 'Saudi Arabia'], ['ko-KR', 'South Korea'], ['es-ES', 'Spain'],
    ['sv-SE', 'Sweden'], ['th-TH', 'Thailand'], ['tr-TR', 'Turkey'], ['en-GB', 'United Kingdom'],
    ['en-US', 'United States'], ['vi', 'Vietnam'],
].map(([id, label]) => ({ id, label }));

export const SAMPLE_GENERATORS = [
    ['auto', 'Auto detect'], ['sequence', 'Sequential ID'], ['uuid', 'UUID'], ['name', 'Full name'],
    ['firstName', 'First name'], ['lastName', 'Last name'], ['username', 'Username'], ['email', 'Email'],
    ['phone', 'Phone'], ['company', 'Company'], ['jobTitle', 'Job title'], ['department', 'Department'],
    ['address', 'Street address'], ['city', 'City'], ['country', 'Country'], ['postal', 'Postal code'],
    ['countryCode', 'Country code'], ['currency', 'Currency code'], ['latitude', 'Latitude'], ['longitude', 'Longitude'],
    ['product', 'Product name'], ['url', 'Website URL'], ['sentence', 'Description'], ['integer', 'Integer'],
    ['sku', 'Product SKU'], ['slug', 'URL slug'], ['status', 'Status'], ['color', 'Hex color'], ['ip', 'IPv4 address'], ['ipv6', 'IPv6 address'],
    ['decimal', 'Decimal'], ['boolean', 'Boolean'], ['date', 'Date'], ['time', 'Time'], ['datetime', 'Date and time'],
    ['json', 'JSON object'], ['choice', 'Custom list'], ['default', 'Database default'], ['null', 'NULL'],
].map(([id, label]) => ({ id, label }));

export function inferSampleGenerator(column) {
    const type = column.type.toUpperCase();
    const name = column.name.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
    if (column.generatedExpr?.length || column.autoIncrement) return 'default';
    if (column.isEnum) return 'choice';
    if (/UUID|UNIQUEIDENTIFIER/.test(type)) return 'uuid';
    if (/BOOL|^BIT\b/.test(type)) return 'boolean';
    if (/TIMESTAMP|DATETIME/.test(type)) return 'datetime';
    if (/^DATE\b/.test(type)) return 'date';
    if (/^TIME\b/.test(type)) return 'time';
    if (/JSON/.test(type)) return 'json';
    if (/^(INET|CIDR)\b/.test(type)) return 'ip';
    if (/^(latitude|lat)$/.test(name) && /DECIMAL|NUMERIC|REAL|FLOAT|DOUBLE/.test(type)) return 'latitude';
    if (/^(longitude|lng|lon)$/.test(name) && /DECIMAL|NUMERIC|REAL|FLOAT|DOUBLE/.test(type)) return 'longitude';
    if (/INT|SERIAL|NUMBER\s*\(\s*\d+\s*,\s*0\s*\)/.test(type)) return column.pk || /(^|_)id$/.test(name) ? 'sequence' : 'integer';
    if (/DECIMAL|NUMERIC|NUMBER|REAL|FLOAT|DOUBLE|MONEY/.test(type)) return 'decimal';
    // SQLite and imported schemas often store dates as TEXT. Recognize clear
    // date/time names after native types, without treating arbitrary *_at text as a timestamp.
    if (/^(?:date|dob|birthdate|date_of_birth)$|_date$|^(?:created|updated|deleted|archived|published|completed|started|finished|expires|expired|modified|joined|registered|cancelled|canceled)_on$/.test(name)) return 'date';
    if (/^(?:time|start_time|end_time|opening_time|closing_time)$/.test(name)) return 'time';
    if (/^(?:timestamp|(?:created|updated|deleted|archived|published|completed|started|finished|expires|expired|modified|last_seen|last_login|last_access|joined|registered|cancelled|canceled)_at)$/.test(name)) return 'datetime';
    if (/first_?name|given_?name/.test(name)) return 'firstName';
    if (/last_?name|family_?name|surname/.test(name)) return 'lastName';
    if (/email/.test(name)) return 'email';
    if (/user_?name|login|handle/.test(name)) return 'username';
    if (/phone|mobile|telephone/.test(name)) return 'phone';
    if (/company|organization|organisation/.test(name)) return 'company';
    if (/department/.test(name)) return 'department';
    if (/job_?title|occupation/.test(name)) return 'jobTitle';
    if (/city|town/.test(name)) return 'city';
    if (/country_?code/.test(name)) return 'countryCode';
    if (/country/.test(name)) return 'country';
    if (/postal|zip/.test(name)) return 'postal';
    if (/address|street/.test(name)) return 'address';
    if (/website|url|homepage|avatar|image/.test(name)) return 'url';
    if (/product|item_?name/.test(name)) return 'product';
    if (/^sku$|product_?code/.test(name)) return 'sku';
    if (/slug/.test(name)) return 'slug';
    if (/status|^state$/.test(name)) return 'status';
    if (/colou?r/.test(name)) return 'color';
    if (/ipv6/.test(name)) return 'ipv6';
    if (/ip_?address|^ip$|^ipv4$/.test(name)) return 'ip';
    if (/currency/.test(name)) return 'currency';
    if (/name/.test(name)) return 'name';
    if (/^id$|_id$|code$|slug$/.test(name)) return 'sequence';
    return 'sentence';
}
