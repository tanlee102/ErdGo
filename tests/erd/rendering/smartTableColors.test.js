/** Verifies deterministic, readable automatic table color assignment. */
import { describe, expect, it } from 'vitest';
import { generateSmartTableColors, getColorContrastRatio, getReadableTableTextColor, getRecommendedTableColorMode, getSmartTableColorFamilies, getSmartTableColorModes, getTableHeaderContrastTreatment, tokenizeSchemaName } from '@/lib/smartTableColors.js';
import { sqlToErdSchema } from '@/lib/erdJsonSchema.js';

function table(name, columns = ['id']) {
    return { name, columns: columns.map((column) => ({ name: column })) };
}

function relation(fromTable, fromColumn, toTable, toColumn = 'id', extra = {}) {
    return { from: { table: fromTable, column: fromColumn }, to: { table: toTable, column: toColumn }, ...extra };
}

function mixHexColors(first, second, amount) {
    const channel = (color, offset) => Number.parseInt(color.slice(offset, offset + 2), 16);
    const toHex = (value) => Math.round(value).toString(16).padStart(2, '0');
    return `#${[1, 3, 5].map((offset) => toHex(channel(first, offset) * (1 - amount) + channel(second, offset) * amount)).join('')}`;
}

describe('smart table colors', () => {
    it('assigns semantic families that match common schema domains', () => {
        const schema = {
            tables: [table('auth.users'), table('billing.invoices'), table('reporting.metrics'), table('content.posts'), table('geo.locations')],
            relations: [],
        };
        const colors = generateSmartTableColors(schema);
        const families = getSmartTableColorFamilies();

        expect(families.identity).toContain(colors['auth.users']);
        expect(families.finance).toContain(colors['billing.invoices']);
        expect(families.analytics).toContain(colors['reporting.metrics']);
        expect(families.content).toContain(colors['content.posts']);
        expect(families.geography).toContain(colors['geo.locations']);
    });

    it('propagates a strong domain through a related component while keeping neighbors distinct', () => {
        const schema = {
            tables: [table('orders', ['id', 'customer_id']), table('order_items', ['order_id', 'product_id']), table('products', ['id'])],
            relations: [relation('order_items', 'order_id', 'orders'), relation('order_items', 'product_id', 'products')],
        };
        const colors = generateSmartTableColors(schema);
        const commerceColors = getSmartTableColorFamilies().commerce;

        expect(commerceColors).toContain(colors.orders);
        expect(commerceColors).toContain(colors.products);
        expect(colors.orders).not.toBe(colors.products);
        expect(colors.order_items).toMatch(/^gradient:#[0-9A-F]{6}:#[0-9A-F]{6}$/i);
    });

    it('uses a meaningful cross-domain gradient for a true junction table', () => {
        const schema = {
            tables: [table('auth.users'), table('content.posts'), table('user_post_links', ['user_id', 'post_id'])],
            relations: [relation('user_post_links', 'user_id', 'auth.users'), relation('user_post_links', 'post_id', 'content.posts')],
        };
        const colors = generateSmartTableColors(schema);

        expect(colors.user_post_links).toBe(`gradient:${colors['auth.users']}:${colors['content.posts']}`);
    });

    it('gives explicit relationships more influence than weak inferred candidates', () => {
        const schema = {
            tables: [table('orders'), table('order_items', ['order_id']), table('audit_logs', ['possible_id'])],
            relations: [relation('order_items', 'order_id', 'orders')],
        };
        const inferredRelations = [relation('order_items', 'possible_id', 'audit_logs', 'id', { inferred: true, confidence: 55 })];
        const colors = generateSmartTableColors(schema, { inferredRelations });
        const commerceColors = getSmartTableColorFamilies().commerce;
        const analyticsColors = getSmartTableColorFamilies().analytics;

        expect(commerceColors).toContain(colors.orders);
        expect(commerceColors).toContain(colors.order_items);
        expect(analyticsColors).toContain(colors.audit_logs);
    });

    it('is deterministic across input ordering and unrelated schema additions', () => {
        const users = table('auth.users');
        const roles = table('auth.roles', ['id', 'user_id']);
        const authRelation = relation('auth.roles', 'user_id', 'auth.users');
        const first = generateSmartTableColors({ tables: [users, roles], relations: [authRelation] });
        const reordered = generateSmartTableColors({ tables: [roles, users], relations: [authRelation] });
        const expanded = generateSmartTableColors({ tables: [table('reporting.metrics'), roles, users], relations: [authRelation] });

        expect(reordered).toEqual(first);
        expect(expanded['auth.users']).toBe(first['auth.users']);
        expect(expanded['auth.roles']).toBe(first['auth.roles']);
    });

    it('keeps every preset readable by adapting header text to the selected color', () => {
        getSmartTableColorModes().forEach((mode) => {
            Object.values(getSmartTableColorFamilies(mode))
                .flat()
                .forEach((color) => {
                    const textColor = getReadableTableTextColor(color);
                    expect(['#000000', '#FFFFFF']).toContain(textColor);
                    expect(getColorContrastRatio(textColor, color)).toBeGreaterThanOrEqual(4.5);
                });
        });
        expect(getReadableTableTextColor('gradient:#60A5FA:#FBBF24')).toBe('#000000');
        expect(getReadableTableTextColor('gradient:#312E81:#581C87')).toBe('#FFFFFF');
    });

    it('adds only the minimum neutral scrim needed for mixed-luminance gradients', () => {
        ['gradient:#2563EB:#06B6D4', 'gradient:#0F766E:#84CC16', 'gradient:#0284C7:#4F46E5'].forEach((color) => {
            const treatment = getTableHeaderContrastTreatment(color);
            expect(treatment.overlayAlpha).toBeGreaterThan(0);
            expect(treatment.overlayAlpha).toBeLessThan(0.2);
            expect(treatment.minimumContrast).toBeGreaterThanOrEqual(4.75);
        });
    });

    it('keeps interpolated pixels readable for every automatic gradient pairing', () => {
        getSmartTableColorModes().forEach((mode) => {
            const colors = [...new Set(Object.values(getSmartTableColorFamilies(mode)).flat())];
            colors.forEach((first, firstIndex) => {
                colors.slice(firstIndex + 1).forEach((second) => {
                    const treatment = getTableHeaderContrastTreatment(`gradient:${first}:${second}`);
                    for (let step = 0; step <= 64; step += 1) {
                        const gradientPixel = mixHexColors(first, second, step / 64);
                        const renderedPixel = mixHexColors(gradientPixel, treatment.overlayColor, treatment.overlayAlpha);
                        expect(getColorContrastRatio(treatment.textColor, renderedPixel)).toBeGreaterThanOrEqual(4.5);
                    }
                });
            });
        });
    });

    it('supports persisted short hex, alpha hex, rgb, rgba, and invalid legacy colors safely', () => {
        ['#fff', '#ffffff80', 'rgb(255,255,255)', 'rgba(255,255,255,0.5)'].forEach((color) => {
            const treatment = getTableHeaderContrastTreatment(color, 4.75, '#323232');
            expect(treatment.textColor).toBe('#000000');
            expect(treatment.minimumContrast).toBeGreaterThanOrEqual(4.75);
        });
        const invalid = getTableHeaderContrastTreatment('not-a-color', 4.75, '#323232');
        expect(invalid.minimumContrast).toBeGreaterThanOrEqual(4.75);
        expect(getTableHeaderContrastTreatment('#5F62F0')).toBe(getTableHeaderContrastTreatment('#5F62F0'));
    });

    it('prefers white text and switches to black only for colors that are too bright', () => {
        expect(getReadableTableTextColor('#5F62F0')).toBe('#FFFFFF');
        expect(getReadableTableTextColor('#A145F3')).toBe('#FFFFFF');
        expect(getReadableTableTextColor('#EF4444')).toBe('#000000');
        expect(getReadableTableTextColor('#F59E0B')).toBe('#000000');
    });

    it('honors a per-table white or black override without sacrificing contrast', () => {
        const forcedWhite = getTableHeaderContrastTreatment('#F59E0B', 4.75, '#FFFFFF', '#FFFFFF');
        const forcedBlack = getTableHeaderContrastTreatment('#312E81', 4.75, '#FFFFFF', '#000000');

        expect(forcedWhite.textColor).toBe('#FFFFFF');
        expect(forcedWhite.overlayAlpha).toBeGreaterThan(0);
        expect(forcedWhite.minimumContrast).toBeGreaterThanOrEqual(4.75);
        expect(forcedBlack.textColor).toBe('#000000');
        expect(forcedBlack.overlayAlpha).toBeGreaterThan(0);
        expect(forcedBlack.minimumContrast).toBeGreaterThanOrEqual(4.75);

        const paints = [
            ...new Set(getSmartTableColorModes().flatMap((mode) => Object.values(getSmartTableColorFamilies(mode)).flat())),
            'gradient:#60A5FA:#FBBF24',
            'gradient:#312E81:#581C87',
            'rgba(255,255,255,0.5)',
            'not-a-color',
        ];
        paints.forEach((paint) => {
            ['#FFFFFF', '#000000'].forEach((textColor) => {
                const treatment = getTableHeaderContrastTreatment(paint, 4.75, '#323232', textColor);
                expect(treatment.textColor).toBe(textColor);
                expect(treatment.minimumContrast).toBeGreaterThanOrEqual(4.75);
            });
        });

        const auto = getTableHeaderContrastTreatment('#F59E0B');
        expect(auto.textColor).toBe('#000000');
        expect(getTableHeaderContrastTreatment('#F59E0B', 4.75, '#FFFFFF', '#FFFFFF').textColor).toBe('#FFFFFF');
        expect(getTableHeaderContrastTreatment('#F59E0B', 4.75, '#FFFFFF', 'invalid')).toBe(auto);
    });

    it('uses vivid jewel tones instead of gray or muddy automatic colors', () => {
        const colors = [...new Set(Object.values(getSmartTableColorFamilies()).flat())];
        colors.forEach((color) => {
            const red = Number.parseInt(color.slice(1, 3), 16);
            const green = Number.parseInt(color.slice(3, 5), 16);
            const blue = Number.parseInt(color.slice(5, 7), 16);
            const chroma = Math.max(red, green, blue) - Math.min(red, green, blue);

            expect(chroma).toBeGreaterThanOrEqual(70);
        });
        expect(colors).toEqual(expect.arrayContaining(['#3B82F6', '#A145F3', '#EC4899', '#F43F5E', '#10B981', '#F97316']));
    });

    it('offers bright, balanced, and deep moods without changing schema intelligence', () => {
        const schema = {
            tables: [table('auth.users'), table('billing.invoices'), table('reporting.metrics')],
            relations: [],
        };
        const bright = generateSmartTableColors(schema, { paletteMode: 'bright' });
        const balanced = generateSmartTableColors(schema, { paletteMode: 'balanced' });
        const deep = generateSmartTableColors(schema, { paletteMode: 'deep' });

        expect(getSmartTableColorModes()).toEqual(['bright', 'balanced', 'deep']);
        expect(generateSmartTableColors(schema)).toEqual(bright);
        expect(generateSmartTableColors(schema, { paletteMode: 'unknown' })).toEqual(bright);
        expect(balanced).not.toEqual(bright);
        expect(deep).not.toEqual(balanced);
        expect(getSmartTableColorFamilies('bright').identity).toContain(bright['auth.users']);
        expect(getSmartTableColorFamilies('balanced').finance).toContain(balanced['billing.invoices']);
        expect(getSmartTableColorFamilies('deep').analytics).toContain(deep['reporting.metrics']);
    });

    it('recommends balanced for light canvases and bright for dark canvases', () => {
        expect(getRecommendedTableColorMode(false)).toBe('balanced');
        expect(getRecommendedTableColorMode(true)).toBe('bright');
        expect(getRecommendedTableColorMode()).toBe('balanced');
    });

    it('handles malformed schemas, ambiguous leaf names, self references, and duplicate relations safely', () => {
        const schema = {
            tables: [table('auth.users', ['id', 'manager_id']), table('crm.users'), { name: '', columns: [] }, null],
            relations: [relation('users', 'manager_id', 'users'), relation('auth.users', 'manager_id', 'auth.users'), relation('missing', 'id', 'auth.users'), null],
        };

        expect(() => generateSmartTableColors(schema)).not.toThrow();
        expect(Object.keys(generateSmartTableColors(schema))).toEqual(['auth.users', 'crm.users']);
        expect(generateSmartTableColors(null)).toEqual({});
    });

    it('tokenizes schema, snake case, plural, and camel case names consistently', () => {
        expect(tokenizeSchemaName('Auth.UserProfiles')).toEqual(expect.arrayContaining(['auth', 'user', 'profile']));
        expect(tokenizeSchemaName('[reporting].[daily_metrics]')).toEqual(expect.arrayContaining(['reporting', 'daily', 'metric']));
    });

    it('keeps every directly related table visually distinct in a real commerce schema', () => {
        const schema = sqlToErdSchema(`
            CREATE TABLE users (id INT PRIMARY KEY, email TEXT UNIQUE);
            CREATE TABLE products (id INT PRIMARY KEY, sku TEXT UNIQUE);
            CREATE TABLE orders (
                id INT PRIMARY KEY,
                user_id INT NOT NULL REFERENCES users(id),
                status TEXT NOT NULL
            );
            CREATE TABLE order_items (
                order_id INT NOT NULL REFERENCES orders(id),
                product_id INT NOT NULL REFERENCES products(id),
                quantity INT NOT NULL,
                PRIMARY KEY (order_id, product_id)
            );
            CREATE TABLE payments (
                id INT PRIMARY KEY,
                order_id INT NOT NULL REFERENCES orders(id),
                amount NUMERIC(12, 2) NOT NULL
            );
            CREATE TABLE audit_logs (
                id INT PRIMARY KEY,
                user_id INT REFERENCES users(id),
                event_name TEXT NOT NULL
            );
        `);
        const colors = generateSmartTableColors(schema);

        schema.relations
            .filter((item) => item.from.table !== item.to.table)
            .forEach((item) => {
                expect(colors[item.from.table]).not.toBe(colors[item.to.table]);
            });
        expect(new Set(Object.values(colors)).size).toBeGreaterThanOrEqual(5);
    });
});
