/** React Flow renderer for Chen and EER entities, relationships, attributes, categories, aggregation, ISA, and notes. */
import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Handle, Position, useUpdateNodeInternals } from '@xyflow/react';
import ErdDraftNodeContext from '../contexts/ErdDraftNodeContext';
import { normalizeDraftNodeSemantics } from '../lib/erdDraftSemantics';
import { draftLabelWidthRatio, draftNodeSize } from '../lib/erdDraftGeometry';

const handlePositions = [
    ['top', Position.Top],
    ['right', Position.Right],
    ['bottom', Position.Bottom],
    ['left', Position.Left],
];

export default function ErdDraftNode({ id, data, selected }) {
    const updateNodeInternals = useUpdateNodeInternals();
    const { readOnly, onLabelChange, connectionSourceId, canConnect, attributesByOwner, showAttributes, showAttributeCounts, collapsedOwners, onToggleAttributes } = useContext(ErdDraftNodeContext);
    const attributeCount = attributesByOwner?.get(id)?.length || 0;
    const attributesCollapsed = showAttributes === false || collapsedOwners?.has(id);
    const shape = data.shape || 'entity';
    const sizeScale = Number(data.sizeScale) || 1;
    const textScale = Number(data.textScale) || 1;
    const savedLabel = typeof data.label === 'string' ? data.label : '';
    const fallbackLabel = shape === 'isa'
        ? 'ISA'
        : shape === 'category'
            ? 'Category'
            : shape === 'aggregation'
                ? 'Relationship group'
                : 'Untitled';
    const showLabel = shape !== 'isa' || normalizeDraftNodeSemantics(shape, data).showLabel;
    const displayLabel = (shape === 'isa' && !savedLabel.trim() ? '' : savedLabel) || fallbackLabel;
    const [isEditing, setIsEditing] = useState(false);
    const [draftLabel, setDraftLabel] = useState(savedLabel);
    const cancelOnBlurRef = useRef(false);
    const editorRef = useRef(null);
    const previewLabel = isEditing ? draftLabel : displayLabel;
    const size = draftNodeSize(shape, sizeScale, previewLabel, textScale);
    const labelWidthRatio = draftLabelWidthRatio(shape, previewLabel, sizeScale, textScale);
    useLayoutEffect(() => {
        // Notation and label visibility can change handle geometry without a resize.
        // Refresh explicitly so fast edits do not leave connectors unmeasured.
        // The library hook uses an unescaped CSS selector; unusual legacy IDs
        // retain its normal ResizeObserver path instead of throwing on lookup.
        if (id && !/["\\\r\n\f]/.test(id)) updateNodeInternals(id);
    }, [id, shape, size.width, size.height, showLabel, updateNodeInternals]);
    const classNames = [
        'erd-draft-node',
        `erd-draft-node--${shape}`,
        selected ? 'is-selected' : '',
        !readOnly ? 'is-inline-editable' : '',
        isEditing ? 'is-editing' : '',
        connectionSourceId && connectionSourceId !== id ? (canConnect?.({ source: connectionSourceId, target: id }) ? 'is-connection-target' : 'is-incompatible-target') : '',
    ].filter(Boolean).join(' ');

    useEffect(() => {
        if (!isEditing) return;
        editorRef.current?.focus();
        editorRef.current?.select();
    }, [isEditing]);

    const startEditing = (event) => {
        if (readOnly) return;
        event.preventDefault();
        event.stopPropagation();
        cancelOnBlurRef.current = false;
        setDraftLabel(savedLabel);
        setIsEditing(true);
    };

    const finishEditing = (shouldCommit) => {
        setIsEditing(false);
        if (shouldCommit && draftLabel !== savedLabel) onLabelChange(id, draftLabel);
    };

    const handleEditorBlur = () => {
        const shouldCommit = !cancelOnBlurRef.current;
        cancelOnBlurRef.current = false;
        finishEditing(shouldCommit);
    };

    const handleEditorKeyDown = (event) => {
        event.stopPropagation();
        if (event.key === 'Escape') {
            event.preventDefault();
            cancelOnBlurRef.current = true;
            setDraftLabel(savedLabel);
            event.currentTarget.blur();
            return;
        }
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            event.currentTarget.blur();
        }
    };

    const labelContent = isEditing ? (
        <textarea
            ref={editorRef}
            className="erd-draft-inline-label-editor nodrag nopan nowheel"
            aria-label={`Edit ${displayLabel} label`}
            aria-multiline="true"
            rows={Math.min(12, Math.max(1, draftLabel.replace(/\r/g, '').split('\n').length))}
            value={draftLabel}
            onChange={(event) => setDraftLabel(event.target.value)}
            onBlur={handleEditorBlur}
            onKeyDown={handleEditorKeyDown}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
        />
    ) : showLabel ? (
        <span
            className="erd-draft-node-label"
            title={readOnly ? undefined : 'Double-click to edit'}
            onDoubleClick={startEditing}
        >
            {displayLabel}
        </span>
    ) : null;

    let content = labelContent;
    if (shape === 'identifyingRelationship') {
        // A clipped pseudo-element shadow cannot draw a second diamond outline.
        const inset = 7;
        content = <><svg className="erd-draft-identifying-outline" viewBox={`0 0 ${size.width} ${size.height}`} aria-hidden="true">
            <polygon points={`${size.width / 2},${inset} ${size.width - inset},${size.height / 2} ${size.width / 2},${size.height - inset} ${inset},${size.height / 2}`} />
        </svg>{labelContent}</>;
    }
    if (!isEditing && shape === 'isa') {
        const constraint = data.specializationConstraint === 'overlapping' ? 'o' : 'd';
        const completeness = data.specializationCompleteness === 'total' ? 'total' : 'partial';
        const constraintDescription = constraint === 'o'
            ? 'Overlapping: may belong to multiple subtypes'
            : 'Disjoint: at most one subtype';
        const coverageDescription = completeness === 'total'
            ? 'Total: every instance belongs to a subtype'
            : 'Partial: may belong to no subtype';
        content = <>{labelContent}<small className="erd-draft-node-constraint" title={`${constraintDescription}; ${coverageDescription}`}>{constraint} · {completeness}</small></>;
    } else if (!isEditing && shape === 'category') {
        content = <><strong className="erd-draft-node-union-symbol">U</strong>{labelContent}<small className="erd-draft-node-constraint">{data.categoryCompleteness === 'total' ? 'total' : 'partial'}</small></>;
    } else if (!isEditing && shape === 'aggregation') {
        content = <><small className="erd-draft-node-kind">Aggregation</small>{labelContent}</>;
    }

    return (
        <div
            className={classNames}
            style={{
                '--draft-node-color': data.color,
                '--draft-node-label-color': shape === 'note' && data.noteTextColorMode !== 'custom'
                    ? 'var(--draft-note-theme-color)'
                    : data.labelTextColor === 'black' ? '#000000' : '#ffffff',
                '--draft-node-label-backdrop': 'var(--draft-node-color, #65758b)',
                '--draft-size-scale': sizeScale,
                '--draft-category-gap': `${Math.round(23 * sizeScale)}px`,
                '--draft-label-width': `${Math.round(labelWidthRatio * 100)}%`,
                '--draft-text-align': data.textAlign || 'left',
                '--draft-text-scale': textScale,
                width: `${size.width}px`,
                height: `${size.height}px`,
            }}
        >
            {handlePositions.map(([id, position]) => (
                <Handle
                    key={id}
                    id={id}
                    className={`erd-draft-handle erd-draft-handle--${id}`}
                    type="source"
                    position={position}
                />
            ))}
            <div className="erd-draft-node-shape" onDoubleClick={shape === 'isa' && !isEditing ? startEditing : undefined}>
                {content}
            </div>
            {showAttributeCounts === true && attributeCount > 0 && !isEditing && <button
                type="button"
                className="erd-draft-attribute-toggle nodrag nopan nokey"
                aria-label={`${attributesCollapsed ? 'Expand' : 'Collapse'} attributes of ${displayLabel}`}
                aria-expanded={!attributesCollapsed}
                onPointerDown={event => event.stopPropagation()}
                onClick={event => { event.stopPropagation(); onToggleAttributes?.(id); }}
            >{attributesCollapsed ? '+' : '−'} {attributeCount}</button>}
        </div>
    );
}
