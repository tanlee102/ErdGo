/**
 * Object utilities — single source of truth for deep value comparison and
 * deep cloning across the editor, save logic, and change-tracking hooks.
 *
 * Behavior contract (do NOT change without updating callers):
 *
 *   deepEqual(a, b):
 *     - reference-equal values are equal (covers identical primitives)
 *     - any falsy value paired with a different value is NOT equal
 *       (matches the legacy `!a || !b` short-circuit used by callers that
 *       intentionally treat `null`/`undefined` contexts as non-equivalent
 *       to populated objects)
 *     - everything else is compared via stable JSON.stringify; cyclic /
 *       non-serialisable values are reported as NOT equal (no throw)
 *
 *   deepClone(value):
 *     - JSON round-trip clone — exactly mirrors the legacy
 *       `try { JSON.parse(JSON.stringify(value)) } catch { null }` shape
 *       used by `cloneContext`. Intentionally NOT `structuredClone` so Dates,
 *       Maps, undefined-in-arrays, etc. behave identically to the original.
 */

export function deepEqual(a, b) {
    if (a === b) return true;
    if (!a || !b) return false;
    try {
        return JSON.stringify(a) === JSON.stringify(b);
    } catch {
        return false;
    }
}

export function deepClone(value) {
    try {
        return JSON.parse(JSON.stringify(value));
    } catch {
        return null;
    }
}

/**
 * Deep clone, but only if the result is a populated plain object.
 *
 * Returns `null` for anything that isn't a non-empty plain object. This is the
 * exact shape the save logic relied on (`cloneContext`) — extracted here so
 * both the save hook and change-tracking hook share one definition.
 */
export function cloneIfPopulatedObject(value) {
    const cloned = deepClone(value);
    if (cloned == null || typeof cloned !== 'object' || Array.isArray(cloned)) {
        return null;
    }
    if (Object.keys(cloned).length < 1) return null;
    return cloned;
}
