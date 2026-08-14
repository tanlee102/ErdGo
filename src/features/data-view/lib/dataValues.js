/**
 * Runtime values and generators shared by Data View statement executors.
 *
 * DEFAULT_SENTINEL is deliberately a Symbol so user data can never collide
 * with it. UUID generation remains nondeterministic production behavior; callers
 * should validate UUID shape and uniqueness rather than exact values.
 */
export const DEFAULT_SENTINEL = Symbol('DEFAULT');

export const UUID_FN_NAMES = new Set([
    'GEN_RANDOM_UUID',
    'UUID_GENERATE_V1',
    'UUID_GENERATE_V3',
    'UUID_GENERATE_V4',
    'UUID_GENERATE_V5',
    'UUID',
    'NEWID',
    'NEWSEQUENTIALID',
    'SYS_GUID',
]);

export function generateUuid() {
    try {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
            return crypto.randomUUID();
        }
    } catch {
        // Some embedded browsers expose crypto but deny randomUUID access.
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (character) => {
        const random = (Math.random() * 16) | 0;
        const value = character === 'x' ? random : (random & 0x3) | 0x8;
        return value.toString(16);
    });
}
