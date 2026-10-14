/**
 * Interactive React Flow edge renderer for editable ERD connectors.
 * Endpoint handles, waypoints, label positions, and cardinality markers are delegated
 * back to the workspace through ErdDraftEdgeContext callbacks.
 */
import { useContext, useEffect, useRef, useState } from 'react';
import { BaseEdge, EdgeLabelRenderer, getStraightPath, useReactFlow } from '@xyflow/react';
import ErdDraftEdgeContext from '../contexts/ErdDraftEdgeContext';
import { formatDraftEdgeEndLabel, getDraftIsaConnection, getDraftCategoryConnection } from '../lib/erdDraftSemantics';
import {
    closestConnectorPosition,
    connectorControlFromPoint,
    pointOnConnector,
    resolveConnectorControl,
    resolveConnectorLabel,
} from '../lib/erdDraftGeometry';

function overlapShapeBoundary(x, y, position, amount) {
    if (position === 'left') return { x: x + amount, y };
    if (position === 'right') return { x: x - amount, y };
    if (position === 'top') return { x, y: y + amount };
    if (position === 'bottom') return { x, y: y - amount };
    return { x, y };
}

function outsideShapeBoundary(x, y, position, amount) {
    if (position === 'left') return { x: x - amount, y };
    if (position === 'right') return { x: x + amount, y };
    if (position === 'top') return { x, y: y - amount };
    if (position === 'bottom') return { x, y: y + amount };
    return { x, y };
}

export default function ErdDraftEdge({
    id,
    source,
    target,
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    data,
    selected,
}) {
    const { screenToFlowPosition, getNode } = useReactFlow();
    const { readOnly, onSelectEdge, onWaypointChange, onLabelPositionChange, onEndpointHandleChange, dimmedEdges } = useContext(ErdDraftEdgeContext);
    const routingPointerRef = useRef(null);
    const routingMouseRef = useRef(false);
    const routingStartRef = useRef(null);
    const endpointDragRef = useRef(null);
    const endpointDidMoveRef = useRef(false);
    const endpointSuppressClickRef = useRef(false);
    const endpointStartRef = useRef(null);
    const labelDragOffsetRef = useRef({ x: 0, y: 0 });
    const [endpointPreview, setEndpointPreview] = useState(null);
    const displaySource = overlapShapeBoundary(sourceX, sourceY, sourcePosition, 5);
    const displayTarget = overlapShapeBoundary(targetX, targetY, targetPosition, 5);
    const [straightPath, straightLabelX, straightLabelY] = getStraightPath({
        sourceX: displaySource.x,
        sourceY: displaySource.y,
        targetX: displayTarget.x,
        targetY: displayTarget.y,
    });
    const storedWaypoint = data?.waypoints?.[0];
    const waypointLayout = resolveConnectorControl(storedWaypoint, displaySource, displayTarget);
    const waypoint = waypointLayout?.point;
    const path = waypoint
        ? `M ${displaySource.x},${displaySource.y} Q ${waypoint.x},${waypoint.y} ${displayTarget.x},${displayTarget.y}`
        : straightPath;
    const curveControlX = waypoint?.x ?? straightLabelX;
    const curveControlY = waypoint?.y ?? straightLabelY;
    const edgeLabelPosition = pointOnConnector(displaySource, displayTarget, waypoint, 0.5);
    const sourceLabelLayout = resolveConnectorLabel(data?.sourceLabelPosition, 0.08, displaySource, displayTarget, waypoint);
    const targetLabelLayout = resolveConnectorLabel(data?.targetLabelPosition, 0.92, displaySource, displayTarget, waypoint);
    const sourceLabelPosition = sourceLabelLayout.point;
    const targetLabelPosition = targetLabelLayout.point;
    const sourceGripPosition = endpointPreview?.end === 'source'
        ? endpointPreview.point
        : outsideShapeBoundary(sourceX, sourceY, sourcePosition, 12);
    const targetGripPosition = endpointPreview?.end === 'target'
        ? endpointPreview.point
        : outsideShapeBoundary(targetX, targetY, targetPosition, 12);
    const sourceEndLabel = formatDraftEdgeEndLabel(data, 'source');
    const targetEndLabel = formatDraftEdgeEndLabel(data, 'target');
    const annotation = data?.connectionKind === 'annotation';
    const isaConnection = !annotation && getDraftIsaConnection(getNode(source), getNode(target));
    const categoryConnection = !annotation && getDraftCategoryConnection(getNode(source), getNode(target));
    const isaRoleLabel = isaConnection && ['supertype', 'subtype'].includes(data?.isaRole)
        ? (data.isaRole === 'supertype' ? 'Supertype' : 'Subtype')
        : '';
    const categoryRoleLabel = categoryConnection && ['member', 'result'].includes(data?.categoryRole)
        ? (data.categoryRole === 'member' ? 'Union member' : 'Resulting subtype') : '';
    const connectorLabel = [isaRoleLabel || categoryRoleLabel || (annotation ? 'Annotation' : ''), data?.label].filter(Boolean).join(' · ');

    useEffect(() => {
        if (readOnly) return;
        if (data?.sourceLabelPosition && !Number.isFinite(data.sourceLabelPosition.t)) {
            onLabelPositionChange(id, 'sourceLabelPosition', sourceLabelLayout.relative);
        }
        if (data?.targetLabelPosition && !Number.isFinite(data.targetLabelPosition.t)) {
            onLabelPositionChange(id, 'targetLabelPosition', targetLabelLayout.relative);
        }
        if (storedWaypoint && !Number.isFinite(storedWaypoint.t)) {
            onWaypointChange(id, waypointLayout.relative);
        }
    }, [data?.sourceLabelPosition, data?.targetLabelPosition, id, onLabelPositionChange, onWaypointChange, readOnly, sourceLabelLayout.relative, storedWaypoint, targetLabelLayout.relative, waypointLayout?.relative]);

    const updateWaypointFromScreen = (clientX, clientY) => {
        if (readOnly) return;
        const point = screenToFlowPosition({ x: clientX, y: clientY });
        onWaypointChange(id, connectorControlFromPoint(point, displaySource, displayTarget));
    };

    const hasMovedEnough = (clientX, clientY, start, threshold = 3) => (
        start && Math.hypot(clientX - start.x, clientY - start.y) >= threshold
    );

    const startRouting = (event) => {
        event.stopPropagation();
        if (event.ctrlKey || event.metaKey) return;
        onSelectEdge(id, event);
        if (readOnly) return;
        routingPointerRef.current = event.pointerId;
        routingStartRef.current = { x: event.clientX, y: event.clientY };
        event.currentTarget.setPointerCapture?.(event.pointerId);
    };

    const moveRouting = (event) => {
        if (routingPointerRef.current !== event.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
        if (!hasMovedEnough(event.clientX, event.clientY, routingStartRef.current)) return;
        updateWaypointFromScreen(event.clientX, event.clientY);
    };

    const stopRouting = (event) => {
        if (routingPointerRef.current !== event.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.releasePointerCapture?.(event.pointerId);
        routingPointerRef.current = null;
        routingStartRef.current = null;
    };

    const startMouseRouting = (event) => {
        event.stopPropagation();
        if (event.ctrlKey || event.metaKey) return;
        onSelectEdge(id, event);
        if (readOnly) return;
        event.preventDefault();
        routingMouseRef.current = true;
        if (!routingStartRef.current) {
            routingStartRef.current = { x: event.clientX, y: event.clientY };
        }
        const move = (moveEvent) => {
            if (!routingMouseRef.current) return;
            if (!hasMovedEnough(moveEvent.clientX, moveEvent.clientY, routingStartRef.current)) return;
            updateWaypointFromScreen(moveEvent.clientX, moveEvent.clientY);
        };
        const stop = () => {
            routingMouseRef.current = false;
            routingStartRef.current = null;
            window.removeEventListener('mousemove', move);
            window.removeEventListener('mouseup', stop);
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', stop);
    };

    const startLabelDrag = (field, labelPosition) => (event) => {
        if (readOnly) return;
        event.preventDefault();
        event.stopPropagation();
        onSelectEdge(id, event);
        const startPointer = screenToFlowPosition({ x: event.clientX, y: event.clientY });
        const startClient = { x: event.clientX, y: event.clientY };
        labelDragOffsetRef.current = {
            x: labelPosition.x - startPointer.x,
            y: labelPosition.y - startPointer.y,
        };
        const move = (moveEvent) => {
            if (!hasMovedEnough(moveEvent.clientX, moveEvent.clientY, startClient, 2)) return;
            const pointer = screenToFlowPosition({ x: moveEvent.clientX, y: moveEvent.clientY });
            const point = {
                x: pointer.x + labelDragOffsetRef.current.x,
                y: pointer.y + labelDragOffsetRef.current.y,
            };
            onLabelPositionChange(id, field, closestConnectorPosition(point, displaySource, displayTarget, waypoint));
        };
        const stop = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', stop);
            window.removeEventListener('pointercancel', stop);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', stop);
        window.addEventListener('pointercancel', stop);
    };

    const finishEndpointDrag = (end, clientX, clientY) => {
        if (readOnly) return;
        if (endpointDragRef.current === null) return;
        endpointDragRef.current = null;
        if (!endpointDidMoveRef.current) {
            onSelectEdge(id);
            endpointDidMoveRef.current = false;
            endpointSuppressClickRef.current = true;
            setEndpointPreview(null);
            return;
        }
        const point = screenToFlowPosition({ x: clientX, y: clientY });
        const node = getNode(end === 'source' ? source : target);
        if (node) {
            const absolute = node.internals?.positionAbsolute || node.position;
            const width = node.measured?.width || node.width || 180;
            const height = node.measured?.height || node.height || 92;
            const dx = point.x - (absolute.x + width / 2);
            const dy = point.y - (absolute.y + height / 2);
            const side = Math.abs(dx) > Math.abs(dy)
                ? (dx < 0 ? 'left' : 'right')
                : (dy < 0 ? 'top' : 'bottom');
            onEndpointHandleChange(id, end === 'source' ? 'sourceHandle' : 'targetHandle', side);
        }
        endpointDidMoveRef.current = false;
        endpointSuppressClickRef.current = true;
        setEndpointPreview(null);
    };

    const handleEndpointKeyDown = (end, event) => {
        const sides = { ArrowUp: 'top', ArrowRight: 'right', ArrowDown: 'bottom', ArrowLeft: 'left' };
        if (readOnly || !sides[event.key]) return;
        event.preventDefault();
        event.stopPropagation();
        onEndpointHandleChange(id, end === 'source' ? 'sourceHandle' : 'targetHandle', sides[event.key]);
    };

    const handleEndpointPointerDown = (end, event) => {
        if (readOnly) return;
        event.stopPropagation();
        if (endpointDragRef.current === null) {
            endpointDidMoveRef.current = false;
            endpointStartRef.current = { x: event.clientX, y: event.clientY };
        }
        endpointDragRef.current = end;
        const move = (moveEvent) => {
            if (Math.hypot(moveEvent.clientX - endpointStartRef.current.x, moveEvent.clientY - endpointStartRef.current.y) > 4) {
                endpointDidMoveRef.current = true;
            }
            setEndpointPreview({ end, point: screenToFlowPosition({ x: moveEvent.clientX, y: moveEvent.clientY }) });
        };
        const stop = (stopEvent) => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', stop);
            window.removeEventListener('pointercancel', stop);
            finishEndpointDrag(end, stopEvent.clientX, stopEvent.clientY);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', stop);
        window.addEventListener('pointercancel', stop);
    };

    const handleEndpointMouseDown = (end, event) => {
        if (readOnly) return;
        event.stopPropagation();
        if (endpointDragRef.current === null) {
            endpointDidMoveRef.current = false;
            endpointStartRef.current = { x: event.clientX, y: event.clientY };
        }
        endpointDragRef.current = end;
        const move = (moveEvent) => {
            if (Math.hypot(moveEvent.clientX - endpointStartRef.current.x, moveEvent.clientY - endpointStartRef.current.y) > 4) {
                endpointDidMoveRef.current = true;
            }
            setEndpointPreview({ end, point: screenToFlowPosition({ x: moveEvent.clientX, y: moveEvent.clientY }) });
        };
        const stop = (stopEvent) => {
            window.removeEventListener('mousemove', move);
            window.removeEventListener('mouseup', stop);
            finishEndpointDrag(end, stopEvent.clientX, stopEvent.clientY);
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', stop);
    };

    const dash = data?.lineStyle === 'dashed' ? '8 6' : data?.lineStyle === 'dotted' ? '2 6' : undefined;
    const edgeColor = selected ? '#2c70ed' : 'var(--draft-edge)';

    return (
        <>
            {data?.lineCount === 'double' && (
                <BaseEdge
                    id={`${id}-participation-outer`}
                    path={path}
                    style={{ stroke: edgeColor, strokeWidth: selected ? 7 : 6, strokeDasharray: dash }}
                />
            )}
            <BaseEdge
                id={id}
                path={path}
                interactionWidth={28}
                style={{
                    stroke: data?.lineCount === 'double' ? 'var(--draft-canvas)' : edgeColor,
                    strokeWidth: data?.lineCount === 'double' ? 2.2 : selected ? 2.6 : 2,
                    strokeDasharray: dash,
                }}
            />
            <path
                className="erd-draft-edge-hit-path"
                d={path}
                fill="none"
                stroke="rgba(44, 112, 237, 0.001)"
                strokeWidth="28"
                role="button"
                aria-label={readOnly ? 'Select connector' : 'Drag connector to curve'}
                onPointerDown={(event) => {
                    startRouting(event);
                }}
                onPointerMove={readOnly ? undefined : moveRouting}
                onPointerUp={readOnly ? undefined : stopRouting}
                onPointerCancel={readOnly ? undefined : stopRouting}
                onMouseDown={readOnly ? undefined : startMouseRouting}
                onClick={(event) => {
                    event.stopPropagation();
                    onSelectEdge(id, event, true);
                }}
            />
            <EdgeLabelRenderer>
                <div className={dimmedEdges?.has(id) && !selected ? 'erd-draft-labels-dimmed' : undefined}>
                {selected && !readOnly && (
                    <>
                        <button
                            className="erd-draft-endpoint-grip nodrag nopan"
                            aria-label="Move from connector head"
                            title="Drag around the shape; use arrow keys to choose a side"
                            onKeyDown={(event) => handleEndpointKeyDown('source', event)}
                            onPointerDown={(event) => handleEndpointPointerDown('source', event)}
                            onMouseDown={(event) => handleEndpointMouseDown('source', event)}
                            onClick={(event) => {
                                event.stopPropagation();
                                if (endpointSuppressClickRef.current) {
                                    endpointSuppressClickRef.current = false;
                                    return;
                                }
                                onSelectEdge(id, event);
                            }}
                            style={{ transform: `translate(-50%, -50%) translate(${sourceGripPosition.x}px, ${sourceGripPosition.y}px)` }}
                        />
                        <button
                            className="erd-draft-endpoint-grip erd-draft-endpoint-grip--target nodrag nopan"
                            aria-label="Move to connector head"
                            title="Drag around the shape; use arrow keys to choose a side"
                            onKeyDown={(event) => handleEndpointKeyDown('target', event)}
                            onPointerDown={(event) => handleEndpointPointerDown('target', event)}
                            onMouseDown={(event) => handleEndpointMouseDown('target', event)}
                            onClick={(event) => {
                                event.stopPropagation();
                                if (endpointSuppressClickRef.current) {
                                    endpointSuppressClickRef.current = false;
                                    return;
                                }
                                onSelectEdge(id, event);
                            }}
                            style={{ transform: `translate(-50%, -50%) translate(${targetGripPosition.x}px, ${targetGripPosition.y}px)` }}
                        />
                    </>
                )}
                {sourceEndLabel && (
                    <button
                        className="erd-draft-end-label nodrag nopan"
                        aria-label="Drag from-end label"
                        title="Drag label"
                        onPointerDown={readOnly ? undefined : startLabelDrag('sourceLabelPosition', sourceLabelPosition)}
                        disabled={readOnly}
                        style={{ transform: `translate(-50%, -50%) translate(${sourceLabelPosition.x}px, ${sourceLabelPosition.y}px)` }}
                    >
                        {sourceEndLabel}
                    </button>
                )}
                {targetEndLabel && (
                    <button
                        className="erd-draft-end-label nodrag nopan"
                        aria-label="Drag to-end label"
                        title="Drag label"
                        onPointerDown={readOnly ? undefined : startLabelDrag('targetLabelPosition', targetLabelPosition)}
                        disabled={readOnly}
                        style={{ transform: `translate(-50%, -50%) translate(${targetLabelPosition.x}px, ${targetLabelPosition.y}px)` }}
                    >
                        {targetEndLabel}
                    </button>
                )}
                {connectorLabel && (
                    <span
                        className="erd-draft-edge-label nodrag nopan"
                        title={connectorLabel}
                        style={{ transform: `translate(-50%, -50%) translate(${edgeLabelPosition.x}px, ${edgeLabelPosition.y}px)` }}
                    >
                        {connectorLabel}
                    </span>
                )}
                {selected && !readOnly && (
                    <>
                        <button
                            className="erd-draft-waypoint nodrag nopan"
                            aria-label="Drag to reroute connector"
                            title="Drag to reroute connector"
                            onPointerDown={startRouting}
                            onPointerMove={moveRouting}
                            onPointerUp={stopRouting}
                            onPointerCancel={stopRouting}
                            onMouseDown={startMouseRouting}
                            style={{ transform: `translate(-50%, -50%) translate(${curveControlX}px, ${curveControlY}px)` }}
                        />
                    </>
                )}
                </div>
            </EdgeLabelRenderer>
        </>
    );
}
