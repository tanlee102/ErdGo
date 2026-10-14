/** Advisory dialect hints for the focused SQL tab, shared by the footer and Add Table. */
import { detectSqlDialectProfile } from '@/lib/sqlDialectProfiles';

function describeDetection(sql, scope) {
    const detected = detectSqlDialectProfile(sql);
    const id = detected.profile.id;
    const mixed = Object.values(detected.scores).filter((score) => score >= 8).length > 1;
    const label = id === 'auto' ? (mixed ? 'Mixed SQL' : 'SQL') : id === 'mssql' ? 'MSSQL' : detected.profile.label;
    const source = scope === 'tab' ? 'focused SQL tab' : 'SQL workspace';
    const description = id !== 'auto'
        ? detected.confidence === 'medium'
            ? `Likely ${label} based on identifier quoting in the ${source}; quoting can also be used by other databases.`
            : `${label} detected from the ${source}.`
        : mixed
            ? `Multiple database dialects detected in the ${source}. Choose the target database manually.`
            : 'No database-specific syntax detected. Portable SQL can work with several databases.';
    return { id, label, confidence: detected.confidence, scope, mixed, description };
}

/**
 * New tables are appended to the focused tab, including inactive drafts. Prefer
 * its own native syntax; inherit from compiled SQL only when the tab is neutral.
 * A mixed tab must never be relabeled using a different tab's dialect.
 */
export function detectEditorSqlDialect(activeSql = '', combinedSql = activeSql) {
    const active = describeDetection(activeSql, 'tab');
    if (active.id !== 'auto' || active.mixed || activeSql === combinedSql) return active;
    const workspace = describeDetection(combinedSql, 'workspace');
    return workspace.id !== 'auto' || workspace.mixed ? workspace : active;
}
