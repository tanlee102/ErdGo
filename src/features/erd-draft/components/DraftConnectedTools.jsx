/** Contextual forms create connected Chen shapes as a single canvas transaction. */
import { useState } from 'react';
import { Plus, Circle, Shapes } from 'lucide-react';
import { connectedDraftAttributeShapes } from '../lib/erdDraftModelTools';
import { isDraftEntityShape } from '../lib/erdDraftSemantics';

export default function DraftConnectedTools({ node, nodes, onCreate }) {
    const attributes = connectedDraftAttributeShapes(node.data.shape);
    const canRelate = isDraftEntityShape(node.data.shape);
    const [mode, setMode] = useState('attribute');
    // Switching tools does not discard either unfinished name; drafts stay local.
    const [names, setNames] = useState({ attribute: '', relationship: '' });
    const [attributeShape, setAttributeShape] = useState('attribute');
    const [targetId, setTargetId] = useState('');
    const [entityLabel, setEntityLabel] = useState('');
    const relation = mode === 'relationship' && canRelate;
    const nameKind = relation ? 'relationship' : 'attribute';
    const label = names[nameKind];
    const setLabel = value => setNames(current => ({ ...current, [nameKind]: value }));
    if (!attributes.length && !canRelate) return null;
    const selectedShape = attributes.some(item => item.type === attributeShape) ? attributeShape : 'attribute';
    const targetExists = !targetId || nodes.some(item => item.id === targetId && isDraftEntityShape(item.data.shape));
    const canSubmit = Boolean(label.trim() && (!relation || (targetExists && (targetId || entityLabel.trim()))));
    const submit = event => {
        event.preventDefault();
        if (!canSubmit) return;
        const created = onCreate(relation
            ? { ownerId: node.id, shape: 'relationship', relationshipLabel: label, targetId, entityLabel }
            : { ownerId: node.id, shape: selectedShape, label });
        if (created) setLabel('');
    };
    return (
        <section className="erd-draft-property-section erd-draft-connected-tools" aria-label="Build from selection">
            <h3>Build from this shape</h3>
            {canRelate && <div className="erd-draft-connected-modes">
                <button type="button" aria-pressed={!relation} onClick={() => setMode('attribute')}><Circle size={14} /> Attribute</button>
                <button type="button" aria-pressed={relation} onClick={() => setMode('relationship')}><Shapes size={14} /> Relationship</button>
            </div>}
            <form onSubmit={submit}>
                {!relation && <label className="erd-draft-field"><span>Attribute type</span>
                    <select value={selectedShape} onChange={event => setAttributeShape(event.target.value)}>{attributes.map(item => <option key={item.type} value={item.type}>{item.label}</option>)}</select>
                </label>}
                <label className="erd-draft-field"><span>{relation ? 'Relationship name' : 'Attribute name'}</span>
                    <input value={label} onChange={event => setLabel(event.target.value)} placeholder={relation ? 'e.g. places' : 'e.g. customer_id'} required />
                </label>
                {relation && <>
                    <label className="erd-draft-field"><span>Related entity</span>
                        <select value={targetId} onChange={event => setTargetId(event.target.value)}>
                            <option value="">Create a new entity</option>
                            {nodes.filter(item => isDraftEntityShape(item.data.shape)).map(item => <option key={item.id} value={item.id}>{item.data.label || 'Untitled'}{item.id === node.id ? ' (this entity)' : ''}</option>)}
                        </select>
                    </label>
                    {!targetId && <label className="erd-draft-field"><span>New entity name</span>
                        <input value={entityLabel} onChange={event => setEntityLabel(event.target.value)} placeholder="e.g. Order" required />
                    </label>}
                </>}
                <button type="submit" className="erd-draft-secondary-action" disabled={!canSubmit}><Plus size={15} />{relation ? 'Create relationship' : 'Add connected attribute'}</button>
            </form>
        </section>
    );
}
