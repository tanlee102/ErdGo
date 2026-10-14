/** Live editor footer summarizing schema size, quality, and detected SQL dialect. */
import { useContext, useLayoutEffect, useMemo, useState } from 'react';
import { RootLayoutContext } from '@/contexts/RootLayoutContext';
import { scoreErdSchema } from '@/lib/schemaQualityScore';
import SchemaStat from '@/components/SchemaStat';
import { detectEditorSqlDialect } from '@/features/editor/lib/sqlDialectDetection';

function getSchemaStats(schema) {
    if (!schema) return { tables: 0, relations: 0, enums: 0, composites: 0 };
    return {
        tables: schema.tables?.length || 0,
        relations: schema.relations?.length || 0,
        enums: schema.enums?.length || 0,
        composites: schema.composites?.length || 0,
    };
}

export default function StatusBar({ schemaVersion = 0, schemaQuality = null, dialectDetection = null }) {
    const { schemaRef, sqlInput } = useContext(RootLayoutContext);
    const detection = useMemo(() => dialectDetection || detectEditorSqlDialect(sqlInput), [dialectDetection, sqlInput]);
    const [stats, setStats] = useState(() => getSchemaStats(null));
    const [calculatedQuality, setCalculatedQuality] = useState(() => scoreErdSchema(null));

    useLayoutEffect(() => {
        setStats(getSchemaStats(schemaRef.current));
        if (!schemaQuality) setCalculatedQuality(scoreErdSchema(schemaRef.current));
    }, [schemaQuality, schemaRef, schemaVersion]);

    const quality = schemaQuality || calculatedQuality;
    const hasScore = Number.isInteger(quality?.score) && quality.score > 0;
    const scoreText = hasScore ? `${quality.score}/100` : '—';
    const scoreLabel = hasScore ? `ERD score, ${quality.score} out of 100, ${quality.label}` : 'ERD score is not available until the schema has a table';

    return (
        <div className="status-bar">
            <div className="schema-info">
                <SchemaStat kind="tables" label="Tables" value={stats.tables} />
                <SchemaStat kind="relations" label="Relations" value={stats.relations} />
                <SchemaStat kind="enums" label="Enums" value={stats.enums} />
                <SchemaStat kind="composites" label="Types" value={stats.composites} />
            </div>
            <div className="status-bar-actions">
                <span className={`schema-score-indicator ${hasScore ? `schema-score-indicator--${String(quality.label || '').toLowerCase().replace(/\s+/g, '-')}` : ''}`} aria-label={scoreLabel} title={scoreLabel}>
                    <span>ERD score</span>{' '}
                    <strong>{scoreText}</strong>
                </span>
                <span className="sql-dialect-indicator" aria-label={`SQL language: ${detection.label}`} title={detection.description} tabIndex={0}>
                    {detection.label}
                </span>
            </div>
        </div>
    );
}
