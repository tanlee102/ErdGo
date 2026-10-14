// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ErdDraftEdge from '@/features/erd-draft/components/ErdDraftEdge.jsx';
import ErdDraftEdgeContext from '@/features/erd-draft/contexts/ErdDraftEdgeContext.js';

const { getNode } = vi.hoisted(() => ({ getNode: vi.fn(() => null) }));

vi.mock('@xyflow/react', () => ({
    BaseEdge: ({ id, path }) => <path data-testid={id} d={path} />,
    EdgeLabelRenderer: ({ children }) => <foreignObject><div>{children}</div></foreignObject>,
    getStraightPath: ({ sourceX, sourceY, targetX, targetY }) => [
        `M ${sourceX},${sourceY} L ${targetX},${targetY}`,
        (sourceX + targetX) / 2,
        (sourceY + targetY) / 2,
    ],
    useReactFlow: () => ({
        screenToFlowPosition: ({ x, y }) => ({ x, y }),
        getNode,
    }),
}));

afterEach(() => {
    cleanup();
    getNode.mockReset();
});

function renderSelectedEdge(overrides = {}) {
    const callbacks = {
        readOnly: false,
        onSelectEdge: vi.fn(),
        onWaypointChange: vi.fn(),
        onLabelPositionChange: vi.fn(),
        onEndpointHandleChange: vi.fn(),
    };
    render(
        <svg>
            <ErdDraftEdgeContext.Provider value={callbacks}>
                <ErdDraftEdge
                    id="edge-1"
                    source="node-a"
                    target="node-b"
                    sourceX={100}
                    sourceY={100}
                    targetX={300}
                    targetY={100}
                    sourcePosition="right"
                    targetPosition="left"
                    data={{ waypoints: [], sourceLabel: '', targetLabel: '', label: '' }}
                    selected
                    {...overrides}
                />
            </ErdDraftEdgeContext.Provider>
        </svg>,
    );
    return callbacks;
}

describe('ERD Builder edge endpoint controls', () => {
    it('shows the explicit ISA role beside a custom label in either connector direction', () => {
        getNode.mockImplementation((id) => ({ id, data: { shape: id === 'node-a' ? 'isa' : 'entity' } }));
        renderSelectedEdge({ data: { label: 'Inheritance', isaRole: 'supertype' } });
        expect(screen.getByText('Supertype · Inheritance')).toBeInTheDocument();
        cleanup();
        getNode.mockImplementation((id) => ({ id, data: { shape: id === 'node-b' ? 'isa' : 'entity' } }));
        renderSelectedEdge({ data: { label: '', isaRole: 'subtype' } });
        expect(screen.getByText('Subtype')).toBeInTheDocument();
        cleanup();
        getNode.mockReturnValue({ data: { shape: 'entity' } });
        renderSelectedEdge({ data: { label: '', isaRole: 'subtype' } });
        expect(screen.queryByText('Subtype')).not.toBeInTheDocument();
    });

    it('renders structured role and min-max cardinality labels', () => {
        renderSelectedEdge({
            data: {
                waypoints: [],
                label: '',
                cardinalityMode: 'minmax',
                sourceRole: 'manager',
                sourceMin: '1',
                sourceMax: '1',
                targetRole: 'report',
                targetMin: '0',
                targetMax: 'N',
            },
        });

        expect(screen.getByRole('button', { name: 'Drag from-end label' })).toHaveTextContent('manager · (1, 1)');
        expect(screen.getByRole('button', { name: 'Drag to-end label' })).toHaveTextContent('report · (0, N)');
    });

    it('selects a connector head without moving it, and supports explicit arrow-key movement', () => {
        const callbacks = renderSelectedEdge();

        fireEvent.click(screen.getByRole('button', { name: 'Move from connector head' }));

        expect(callbacks.onSelectEdge).toHaveBeenCalledWith('edge-1', expect.objectContaining({ ctrlKey: false, metaKey: false }));
        expect(callbacks.onEndpointHandleChange).not.toHaveBeenCalled();
        fireEvent.keyDown(screen.getByRole('button', { name: 'Move from connector head' }), { key: 'ArrowDown' });
        expect(callbacks.onEndpointHandleChange).toHaveBeenCalledTimes(1);
        expect(callbacks.onEndpointHandleChange).toHaveBeenCalledWith('edge-1', 'sourceHandle', 'bottom');
    });

    it('does not move on pointer-up followed by a browser click', () => {
        const callbacks = renderSelectedEdge();
        const grip = screen.getByRole('button', { name: 'Move from connector head' });

        fireEvent.pointerDown(grip, { pointerId: 7, clientX: 112, clientY: 100 });
        fireEvent.pointerUp(window, { pointerId: 7, clientX: 112, clientY: 100 });
        fireEvent.click(grip);

        expect(callbacks.onEndpointHandleChange).not.toHaveBeenCalled();
    });

    it('removes connector mutation handles in read-only mode', () => {
        const callbacks = {
            readOnly: true,
            onSelectEdge: vi.fn(),
            onWaypointChange: vi.fn(),
            onLabelPositionChange: vi.fn(),
            onEndpointHandleChange: vi.fn(),
        };
        render(
            <svg>
                <ErdDraftEdgeContext.Provider value={callbacks}>
                    <ErdDraftEdge
                        id="edge-read-only"
                        source="node-a"
                        target="node-b"
                        sourceX={100}
                        sourceY={100}
                        targetX={300}
                        targetY={100}
                        sourcePosition="right"
                        targetPosition="left"
                        data={{ waypoints: [], sourceLabel: '', targetLabel: '', label: '' }}
                        selected
                    />
                </ErdDraftEdgeContext.Provider>
            </svg>,
        );

        expect(screen.queryByRole('button', { name: 'Move from connector head' })).not.toBeInTheDocument();
        fireEvent.pointerDown(screen.getByRole('button', { name: 'Select connector' }));
        expect(callbacks.onSelectEdge).toHaveBeenCalledWith('edge-read-only', expect.objectContaining({ type: 'pointerdown' }));
        expect(callbacks.onWaypointChange).not.toHaveBeenCalled();
        expect(callbacks.onEndpointHandleChange).not.toHaveBeenCalled();
    });
});
