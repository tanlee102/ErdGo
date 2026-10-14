/** Local free-form ERD Builder workspace. */
import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
    applyEdgeChanges,
    applyNodeChanges,
    Background,
    BackgroundVariant,
    ConnectionMode,
    Controls,
    MiniMap,
    Panel,
    ReactFlow,
    reconnectEdge,
    useReactFlow,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { layoutGraph } from '@/lib/elkLayout';
import {
    ArrowDownRight,
    Box,
    Check,
    ChevronDown,
    ChevronLeft,
    ChevronRight,
    Circle,
    Code2,
    Download,
    FileJson,
    GripVertical,
    KeyRound,
    LayoutGrid,
    Layers,
    Moon,
    MousePointer2,
    Redo2,
    Route,
    Save,
    Shapes,
    Sparkles,
    Sun,
    Trash2,
    Undo2,
    WandSparkles,
} from 'lucide-react';
import HomeIcon from '@/icons/HomeIcon';
import ListIcon from '@/icons/ListIcon';
import { ThemeContext } from '@/contexts/ThemeContext';
import { RootLayoutContext } from '@/contexts/RootLayoutContext';
import CreateNewFileDialog from '@/components/CreateNewFileDialog';
import { useConfirm } from '@/components/ConfirmDialog';
import { useNavigationGuard } from '@/components/NavigationGuard';
import { useNotifications } from '@/components/Notifications';
import { getLocalToolDocument, saveLocalDocument } from '@/features/files/lib/localFileStore';
import { FILE_KINDS } from '@/features/files/lib/fileDocuments';
import { useUnsavedChangesWarning } from '@/features/files/hooks/useUnsavedChangesWarning';
import { createLocalDocumentSnapshot, useLocalDocumentState } from '@/features/files/hooks/useLocalDocumentState';
import LocalDocumentLoadState from '@/features/files/components/LocalDocumentLoadState';
import ErdExportDialog from '@/features/editor/components/ErdExportDialog';
import ErdDraftNode from './ErdDraftNode';
import DraftCardinalityFields from './DraftCardinalityFields';
import DraftSelectionTools from './DraftSelectionTools';
import DraftConnectedTools from './DraftConnectedTools';
import DraftCanvasViewTools from './DraftCanvasViewTools';
import DraftSqlExportDialog from './DraftSqlExportDialog';
import ErdDraftEdge from './ErdDraftEdge';
import ErdDraftEdgeContext from '../contexts/ErdDraftEdgeContext';
import ErdDraftNodeContext from '../contexts/ErdDraftNodeContext';
import { blankDraft, draftTemplates, healthcareDraft, shapeCatalog } from '../data/draftTemplate';
import {
    getDraftIsaConnection,
    getDraftCategoryConnection,
    isDraftSemanticConnection,
    isDraftAttributeShape,
    isDraftEntityShape,
    isDraftRelationshipShape,
    normalizeDraftEdgeSemantics,
    normalizeDraftNodeSemantics,
    validateErdDraftGraph,
} from '../lib/erdDraftSemantics';
import { draftNodeSize, findOpenNodePosition } from '../lib/erdDraftGeometry';
import {
    areErdDraftSnapshotsEqual,
    createErdDraftHistory,
    recordErdDraftHistory,
    redoErdDraftHistory,
    undoErdDraftHistory,
} from '../lib/erdDraftHistory';
import {
    ERD_DRAFT_LAYOUT_MODES,
    ERD_DRAFT_LAYOUT_OPTIONS,
    getErdDraftLayoutPlan,
    draftLayoutEdges,
    createChenDraftLayoutGraph,
    applyChenDraftLayout,
    getDraftRepeatedParticipationIds,
    separateDraftParticipationPaths,
} from '../lib/erdDraftLayout';
import { getDraftAttributeTrees, getDraftCanvasView, createConnectedDraftFragment, revealDraftAttributeGroups } from '../lib/erdDraftModelTools';
import { exportErdDraftPng } from '../lib/erdDraftExport';
import { arrangeDraftSelection, copyDraftSelection, pasteDraftSelection, removeDraftSelection } from '../lib/erdDraftSelection';
import './erd-draft.css';

const nodeTypes = { erdDraftNode: ErdDraftNode };
const edgeTypes = { erdDraftEdge: ErdDraftEdge };
const compactViewportQuery = '(max-width: 900px)';
const colorOptions = ['#2389dd', '#2c70ed', '#6558d3', '#f5662b', '#e84f72', '#98c45f', '#28a58d', '#65758b'];
const handleIds = new Set(['top', 'right', 'bottom', 'left']);
// Wide Chen diagrams need an overview below 20% on phones. Live and saved
// cameras must share these limits so hydration does not crop a fitted diagram.
const DRAFT_MIN_ZOOM = 0.05;
const DRAFT_MAX_ZOOM = 2.2;
// Reserve the floating panel/control area so fitting cannot cover corner handles.
// Pixel padding remains usable on narrow screens, unlike a small percentage.
const DRAFT_FIT_PADDING = { top: '104px', right: '64px', bottom: '112px', left: '32px' };

const shapeIcons = {
    entity: Box,
    weakEntity: Layers,
    relationship: Shapes,
    identifyingRelationship: Shapes,
    attribute: Circle,
    keyAttribute: KeyRound,
    partialKeyAttribute: KeyRound,
    multivaluedAttribute: Circle,
    derivedAttribute: Circle,
    compositeAttribute: Circle,
    isa: ArrowDownRight,
    category: Circle,
    aggregation: Layers,
    note: FileJson,
};

const shapeGroups = ['Core', 'Attributes', 'Extended ER', 'Notes'].map((name) => ({
    name,
    shapes: shapeCatalog.filter((shape) => shape.group === name),
}));

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function finiteNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function normalizeRelativePosition(position, minT, maxT) {
    if (Number.isFinite(position?.t)) {
        return {
            t: clamp(Number(position.t), minT, maxT),
            offset: finiteNumber(position.offset, 0),
        };
    }
    if (Number.isFinite(position?.x) && Number.isFinite(position?.y)) {
        return { x: Number(position.x), y: Number(position.y) };
    }
    return null;
}

function normalizeEdge(edge) {
    const {
        sourceCardinality: _sourceCardinality,
        targetCardinality: _targetCardinality,
        sourceMarker: _sourceMarker,
        targetMarker: _targetMarker,
        ...edgeData
    } = edge.data || {};
    const sourceLabel = edgeData.sourceLabel ?? _sourceCardinality ?? '';
    const targetLabel = edgeData.targetLabel ?? _targetCardinality ?? '';
    const semanticData = normalizeDraftEdgeSemantics({ ...edgeData, sourceLabel, targetLabel });
    const waypoint = normalizeRelativePosition(edgeData.waypoints?.[0], -2, 3);
    return {
        ...edge,
        id: String(edge.id || ''),
        source: String(edge.source || ''),
        target: String(edge.target || ''),
        sourceHandle: handleIds.has(edge.sourceHandle) ? edge.sourceHandle : null,
        targetHandle: handleIds.has(edge.targetHandle) ? edge.targetHandle : null,
        type: 'erdDraftEdge',
        zIndex: 0,
        selected: Boolean(edge.selected),
        data: {
            ...semanticData,
            lineStyle: ['solid', 'dashed', 'dotted'].includes(edgeData.lineStyle) ? edgeData.lineStyle : 'solid',
            lineCount: edgeData.lineCount === 'double' ? 'double' : 'single',
            label: String(edgeData.label ?? ''),
            sourceLabelPosition: normalizeRelativePosition(edgeData.sourceLabelPosition, 0.02, 0.98),
            targetLabelPosition: normalizeRelativePosition(edgeData.targetLabelPosition, 0.02, 0.98),
            waypoints: waypoint ? [waypoint] : [],
            routing: 'auto',
        },
    };
}

function normalizeNode(node) {
    const requestedShape = String(node?.data?.shape || 'entity');
    const shape = shapeCatalog.some((item) => item.type === requestedShape) ? requestedShape : 'entity';
    const catalogItem = shapeCatalog.find((item) => item.type === shape) || shapeCatalog[0];
    const semanticData = normalizeDraftNodeSemantics(shape, node.data || {});
    return {
        ...node,
        id: String(node.id || ''),
        type: 'erdDraftNode',
        position: {
            x: finiteNumber(node.position?.x, 0),
            y: finiteNumber(node.position?.y, 0),
        },
        data: {
            ...semanticData,
            shape,
            label: String(node.data?.label ?? 'Untitled'),
            color: typeof node.data?.color === 'string' ? node.data.color : catalogItem.color,
            description: String(node.data?.description ?? ''),
            sizeScale: clamp(finiteNumber(node.data?.sizeScale, 1), 0.6, 1.8),
            textScale: clamp(finiteNumber(node.data?.textScale, 1), 0.6, 1.8),
        },
    };
}

function normalizeGraphParts(rawNodes, rawEdges) {
    const nodeIds = new Set();
    const nodes = (Array.isArray(rawNodes) ? rawNodes : [])
        .filter((node) => node && typeof node.id === 'string' && node.id && !nodeIds.has(node.id) && nodeIds.add(node.id))
        .map((node) => ({ ...normalizeNode(node), selected: false }));
    const validNodeIds = new Set(nodes.map((node) => node.id));
    const edgeIds = new Set();
    const edges = (Array.isArray(rawEdges) ? rawEdges : [])
        .filter((edge) => (
            edge
            && typeof edge.id === 'string'
            && edge.id
            && !edgeIds.has(edge.id)
            && edgeIds.add(edge.id)
            && validNodeIds.has(String(edge.source || ''))
            && validNodeIds.has(String(edge.target || ''))
            && String(edge.source || '') !== String(edge.target || '')
        ))
        .map(normalizeEdge)
        .map((edge) => withSmartHandles(edge, nodes));
    return { nodes, edges };
}

function createPersistedDraftGraph(rawNodes, rawEdges) {
    const graph = normalizeGraphParts(rawNodes, rawEdges);
    return {
        nodes: graph.nodes.map((node) => {
            const persistedNode = { ...node };
            delete persistedNode.selected;
            delete persistedNode.dragging;
            delete persistedNode.measured;
            delete persistedNode.width;
            delete persistedNode.height;
            return persistedNode;
        }),
        edges: graph.edges.map((edge) => {
            const persistedEdge = { ...edge };
            delete persistedEdge.selected;
            return persistedEdge;
        }),
    };
}

function createDraftContentSnapshot(name, rawNodes, rawEdges) {
    return JSON.stringify({
        name: String(name || '').trim(),
        ...createPersistedDraftGraph(rawNodes, rawEdges),
    });
}

function withSmartHandles(edge, nodes) {
    if (edge.sourceHandle && edge.targetHandle) return edge;
    const source = nodes.find((node) => node.id === edge.source);
    const target = nodes.find((node) => node.id === edge.target);
    if (!source || !target) return edge;
    const sourceSize = nodeSize(source.data.shape, source.data.sizeScale, source.data.label, source.data.textScale);
    const targetSize = nodeSize(target.data.shape, target.data.sizeScale, target.data.label, target.data.textScale);
    const dx = target.position.x + targetSize.width / 2 - (source.position.x + sourceSize.width / 2);
    const dy = target.position.y + targetSize.height / 2 - (source.position.y + sourceSize.height / 2);
    const horizontal = Math.abs(dx) >= Math.abs(dy);
    const sourceHandle = horizontal ? (dx >= 0 ? 'right' : 'left') : (dy >= 0 ? 'bottom' : 'top');
    const targetHandle = horizontal ? (dx >= 0 ? 'left' : 'right') : (dy >= 0 ? 'top' : 'bottom');
    return { ...edge, sourceHandle: edge.sourceHandle || sourceHandle, targetHandle: edge.targetHandle || targetHandle };
}

function graphFromTemplate(template) {
    const graph = normalizeGraphParts(clone(template.nodes), clone(template.edges));
    return {
        name: template.name,
        nodes: graph.nodes,
        edges: graph.edges,
        viewport: null,
    };
}

function normalizeViewport(viewport) {
    const x = Number(viewport?.x);
    const y = Number(viewport?.y);
    const zoom = Number(viewport?.zoom);
    if (![x, y, zoom].every(Number.isFinite) || zoom <= 0) return null;
    return { x, y, zoom: clamp(zoom, DRAFT_MIN_ZOOM, DRAFT_MAX_ZOOM) };
}

function sameViewport(first, second) {
    if (!first || !second) return first === second;
    return first.x === second.x && first.y === second.y && first.zoom === second.zoom;
}

function createDraftNode(shape, position) {
    const catalogItem = shapeCatalog.find((item) => item.type === shape) || shapeCatalog[0];
    return {
        id: `${shape}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        type: 'erdDraftNode',
        position,
        data: normalizeDraftNodeSemantics(shape, {
            shape,
            label: catalogItem.defaultLabel || catalogItem.label,
            color: catalogItem.color,
            description: '',
            sizeScale: 1,
            textScale: 1,
        }),
    };
}

function inspectorNodeName(node) {
    const label = String(node?.data?.label || '').replace(/\n/g, ' ');
    return node?.data?.shape === 'isa' && !label.trim() ? 'ISA' : label;
}

function nodeSize(shape, sizeScale = 1, label = '', textScale = 1) {
    return draftNodeSize(shape, sizeScale, label, textScale);
}

function relationshipRoleEndsForEdge(source, target, nodes) {
    const endpointNodes = {
        source: nodes.find((item) => item.id === source),
        target: nodes.find((item) => item.id === target),
    };
    return ['source', 'target'].filter((end) => {
        const oppositeEnd = end === 'source' ? 'target' : 'source';
        const endpointShape = endpointNodes[end]?.data?.shape;
        const oppositeShape = endpointNodes[oppositeEnd]?.data?.shape;
        const isParticipant = isDraftEntityShape(endpointShape) || endpointShape === 'category' || endpointShape === 'aggregation';
        return isParticipant && isDraftRelationshipShape(oppositeShape);
    });
}

function isCompactViewport() {
    return typeof window !== 'undefined'
        && typeof window.matchMedia === 'function'
        && window.matchMedia(compactViewportQuery).matches;
}

export default function ErdDraftWorkspace({ index = 'new' }) {
    const navigate = useNavigate();
    const { isDark, toggleTheme } = useContext(ThemeContext);
    const { openTypedFileList } = useContext(RootLayoutContext);
    const { confirm } = useConfirm();
    const { runAfterNavigationConfirm } = useNavigationGuard();
    const { notifyError } = useNotifications();
    const [initialGraph] = useState(() => graphFromTemplate(healthcareDraft));
    const [nodes, setNodes] = useState(initialGraph.nodes);
    const [edges, setEdges] = useState(initialGraph.edges);
    const [localViewport, setLocalViewport] = useState(() => normalizeViewport(initialGraph.viewport));
    const [diagramName, setDiagramName] = useState(initialGraph.name);
    const [templateBaseline, setTemplateBaseline] = useState(() => (
        createDraftContentSnapshot(initialGraph.name, initialGraph.nodes, initialGraph.edges)
    ));
    const [selectedNodeId, setSelectedNodeId] = useState(null);
    const [selectedEdgeId, setSelectedEdgeId] = useState(null);
    const [connectionKind, setConnectionKind] = useState('semantic');
    const [connectionSourceId, setConnectionSourceId] = useState(null);
    const [showAttributes, setShowAttributes] = useState(true);
    const [showAttributeCounts, setShowAttributeCounts] = useState(false);
    const [collapsedOwners, setCollapsedOwners] = useState(() => new Set());
    const [focusId, setFocusId] = useState(null);
    const [leftOpen, setLeftOpen] = useState(() => !isCompactViewport());
    const [rightOpen, setRightOpen] = useState(() => !isCompactViewport());
    const [isLocalLoading, setIsLocalLoading] = useState(() => Boolean(index && index !== 'new'));
    const [localLoadError, setLocalLoadError] = useState('');
    const [localLoadAttempt, setLocalLoadAttempt] = useState(0);
    const [isDocumentReady, setIsDocumentReady] = useState(() => !index || index === 'new');
    const [isLoadResolved, setIsLoadResolved] = useState(() => !index || index === 'new');
    const [isExportOpen, setIsExportOpen] = useState(false);
    const [sqlExportGraph, setSqlExportGraph] = useState(null);
    const [isMinimapOpen, setIsMinimapOpen] = useState(false);
    const [isLayoutMenuOpen, setIsLayoutMenuOpen] = useState(false);
    const [isLayoutRunning, setIsLayoutRunning] = useState(false);
    const [lastLayoutMode, setLastLayoutMode] = useState(ERD_DRAFT_LAYOUT_MODES.SMART);
    const [isStartDialogOpen, setIsStartDialogOpen] = useState(() => !index || index === 'new');
    const [toast, setToast] = useState('');
    const [canvasHintVisible, setCanvasHintVisible] = useState(true);
    const [palettePointerDrag, setPalettePointerDrag] = useState(null);
    const canvasRef = useRef(null);
    const toastTimerRef = useRef(null);
    const palettePointerDragRef = useRef(null);
    const suppressPaletteClickRef = useRef(false);
    const localLoadSequenceRef = useRef(0);
    const createdDocumentRef = useRef(null);
    const latestContentRef = useRef(null);
    const clipboardRef = useRef(null);
    const pasteCountRef = useRef(0);
    const [canPaste, setCanPaste] = useState(false);
    const localViewportHydrationRef = useRef(false);
    const layoutMenuRef = useRef(null);
    const layoutButtonRef = useRef(null);
    const canvasHistoryRef = useRef(createErdDraftHistory(createPersistedDraftGraph(initialGraph.nodes, initialGraph.edges)));
    const pendingHistorySnapshotRef = useRef(null);
    const historyTimerRef = useRef(null);
    const historyRecordingRef = useRef(true);
    const historyInteractionRef = useRef({ pointer: false, field: false, keyboard: false });
    const reconnectingEdgeRef = useRef(null);
    const [historyControls, setHistoryControls] = useState({ canUndo: false, canRedo: false });
    const reactFlow = useReactFlow();
    const exportRendering = useMemo(() => ({
        exportPng: (options) => exportErdDraftPng({
            canvasElement: canvasRef.current,
            nodes: reactFlow.getNodes(),
            viewport: reactFlow.getViewport(),
            screenToFlowPosition: reactFlow.screenToFlowPosition,
            ...options,
        }),
    }), [reactFlow]);
    const activeUuid = index && index !== 'new' ? index : null;
    const isReadOnlyLocalFile = Boolean(activeUuid && isLoadResolved && !isDocumentReady);
    const isLocalLoadBlocked = isLocalLoading || Boolean(localLoadError);
    const isEditingDisabled = isLocalLoadBlocked || isReadOnlyLocalFile;
    const isVisualInteractionDisabled = isLocalLoadBlocked;
    const isShapeLibraryOpen = leftOpen && !isReadOnlyLocalFile;
    const persistedGraph = useMemo(
        () => createPersistedDraftGraph(nodes, edges),
        [edges, nodes],
    );
    const currentDraftContentSnapshot = useMemo(
        () => createDraftContentSnapshot(diagramName, persistedGraph.nodes, persistedGraph.edges),
        [diagramName, persistedGraph],
    );
    useLayoutEffect(() => {
        latestContentRef.current = currentDraftContentSnapshot;
    }, [currentDraftContentSnapshot]);
    const currentLocalSnapshot = useMemo(
        () => createLocalDocumentSnapshot(diagramName, {
            schemaVersion: 3,
            nodes: persistedGraph.nodes,
            edges: persistedGraph.edges,
            viewport: localViewport,
        }),
        [localViewport, diagramName, persistedGraph],
    );
    const {
        isLocalSaving,
        hasUnsavedChanges,
        resetLocalState,
        beginLocalLoad,
        finishLocalLoad,
        failLocalLoad,
        beginLocalSave,
        finishLocalSave,
        failLocalSave,
    } = useLocalDocumentState({
        currentSnapshot: currentLocalSnapshot,
    });
    useUnsavedChangesWarning(
        hasUnsavedChanges && !isLocalLoadBlocked && !isStartDialogOpen && !isReadOnlyLocalFile,
    );

    const selectedNode = nodes.find((node) => node.id === selectedNodeId) || null;
    const selectedEdge = edges.find((edge) => edge.id === selectedEdgeId) || null;
    const attributeTrees = useMemo(() => getDraftAttributeTrees(nodes, edges), [nodes, edges]);
    const canvasView = useMemo(() => getDraftCanvasView(nodes, edges, attributeTrees, { showAttributes, collapsedOwners, focusId }), [nodes, edges, attributeTrees, showAttributes, collapsedOwners, focusId]);
    // The global toggle follows actual detail visibility, including per-owner collapse.
    const hasVisibleAttributes = [...attributeTrees.ownerByAttribute.keys()].some(id => !canvasView.hiddenNodes.has(id));
    const displayNodes = useMemo(() => nodes.map(node => ({
        ...node,
        hidden: canvasView.hiddenNodes.has(node.id),
        className: `${node.className || ''}${canvasView.focused && !canvasView.activeNodes.has(node.id) ? ' erd-draft-is-dimmed' : ''}`.trim(),
        draggable: !isVisualInteractionDisabled && !node.data?.positionLocked,
    })), [nodes, isVisualInteractionDisabled, canvasView]);
    const displayEdges = useMemo(() => edges.map(edge => ({
        ...edge,
        hidden: canvasView.hiddenEdges.has(edge.id),
        className: `${edge.className || ''}${canvasView.dimmedEdges.has(edge.id) ? ' erd-draft-is-dimmed' : ''}`.trim(),
    })), [edges, canvasView]);
    // Hidden selections must never be silently deleted, copied, or edited.
    useEffect(() => {
        if (nodes.some(node => node.selected && canvasView.hiddenNodes.has(node.id))) setNodes(items => items.map(node => canvasView.hiddenNodes.has(node.id) ? { ...node, selected: false } : node));
        if (edges.some(edge => edge.selected && canvasView.hiddenEdges.has(edge.id))) setEdges(items => items.map(edge => canvasView.hiddenEdges.has(edge.id) ? { ...edge, selected: false } : edge));
        if (canvasView.hiddenNodes.has(selectedNodeId)) setSelectedNodeId(null);
        if (canvasView.hiddenEdges.has(selectedEdgeId)) setSelectedEdgeId(null);
    }, [canvasView, edges, nodes, selectedNodeId, selectedEdgeId]);
    const selectionCount = nodes.filter(node => node.selected).length + edges.filter(edge => edge.selected).length;
    const validationIssues = useMemo(() => validateErdDraftGraph(nodes, edges), [edges, nodes]);

    const stats = useMemo(() => ({
        entities: nodes.filter((node) => isDraftEntityShape(node.data.shape)).length,
        relationships: nodes.filter((node) => isDraftRelationshipShape(node.data.shape)).length,
        attributes: nodes.filter((node) => isDraftAttributeShape(node.data.shape)).length,
    }), [nodes]);

    const showToast = useCallback((message) => {
        setToast(message);
        window.clearTimeout(toastTimerRef.current);
        toastTimerRef.current = window.setTimeout(() => setToast(''), 2200);
    }, []);

    const clearSelection = useCallback(() => {
        setSelectedNodeId(null);
        setSelectedEdgeId(null);
        setNodes(items => items.some(node => node.selected) ? items.map(node => ({ ...node, selected: false })) : items);
        setEdges(items => items.some(edge => edge.selected) ? items.map(edge => ({ ...edge, selected: false })) : items);
    }, []);

    const refreshHistoryControls = useCallback(() => {
        const hasPendingChange = Boolean(pendingHistorySnapshotRef.current);
        setHistoryControls({
            canUndo: hasPendingChange || canvasHistoryRef.current.past.length > 0,
            canRedo: !hasPendingChange && canvasHistoryRef.current.future.length > 0,
        });
    }, []);

    const commitPendingHistory = useCallback(() => {
        window.clearTimeout(historyTimerRef.current);
        historyTimerRef.current = null;
        const pendingSnapshot = pendingHistorySnapshotRef.current;
        if (!pendingSnapshot) return canvasHistoryRef.current;
        canvasHistoryRef.current = recordErdDraftHistory(canvasHistoryRef.current, pendingSnapshot);
        pendingHistorySnapshotRef.current = null;
        refreshHistoryControls();
        return canvasHistoryRef.current;
    }, [refreshHistoryControls]);

    // A complete pointer gesture or focused text edit is one undo step, regardless of pauses.
    const beginHistoryInteraction = useCallback((kind) => {
        if (historyInteractionRef.current[kind]) return;
        commitPendingHistory();
        historyInteractionRef.current[kind] = true;
    }, [commitPendingHistory]);

    const endHistoryInteraction = useCallback((kind) => {
        historyInteractionRef.current[kind] = false;
        if (!Object.values(historyInteractionRef.current).some(Boolean)) {
            window.clearTimeout(historyTimerRef.current);
            historyTimerRef.current = window.setTimeout(commitPendingHistory, 0);
        }
    }, [commitPendingHistory]);

    useEffect(() => {
        const endPointer = () => endHistoryInteraction('pointer');
        const endKey = (event) => {
            if (event.key.startsWith('Arrow')) endHistoryInteraction('keyboard');
        };
        const endAll = () => {
            historyInteractionRef.current = { pointer: false, field: false, keyboard: false };
            endHistoryInteraction('pointer');
        };
        window.addEventListener('pointerup', endPointer);
        window.addEventListener('pointercancel', endPointer);
        window.addEventListener('keyup', endKey);
        window.addEventListener('blur', endAll);
        return () => {
            window.removeEventListener('pointerup', endPointer);
            window.removeEventListener('pointercancel', endPointer);
            window.removeEventListener('keyup', endKey);
            window.removeEventListener('blur', endAll);
        };
    }, [endHistoryInteraction]);

    const resetCanvasHistory = useCallback((nextNodes, nextEdges) => {
        window.clearTimeout(historyTimerRef.current);
        historyTimerRef.current = null;
        historyInteractionRef.current = { pointer: false, field: false, keyboard: false };
        pendingHistorySnapshotRef.current = null;
        canvasHistoryRef.current = createErdDraftHistory(createPersistedDraftGraph(nextNodes, nextEdges));
        refreshHistoryControls();
    }, [refreshHistoryControls]);

    const applyCanvasHistorySnapshot = useCallback((snapshot) => {
        const graph = createPersistedDraftGraph(snapshot.nodes, snapshot.edges);
        setNodes(graph.nodes);
        setEdges(graph.edges);
        clearSelection();
    }, [clearSelection]);

    const undoCanvas = useCallback(() => {
        if (isLocalLoadBlocked) return;
        const history = commitPendingHistory();
        const result = undoErdDraftHistory(history);
        if (!result.changed) return;
        canvasHistoryRef.current = result.history;
        applyCanvasHistorySnapshot(result.snapshot);
        refreshHistoryControls();
    }, [applyCanvasHistorySnapshot, commitPendingHistory, isLocalLoadBlocked, refreshHistoryControls]);

    const redoCanvas = useCallback(() => {
        if (isLocalLoadBlocked) return;
        const history = commitPendingHistory();
        const result = redoErdDraftHistory(history);
        if (!result.changed) return;
        canvasHistoryRef.current = result.history;
        applyCanvasHistorySnapshot(result.snapshot);
        refreshHistoryControls();
    }, [applyCanvasHistorySnapshot, commitPendingHistory, isLocalLoadBlocked, refreshHistoryControls]);

    useEffect(() => {
        if (!historyRecordingRef.current || isLocalLoadBlocked) return;
        const nextSnapshot = {
            nodes: persistedGraph.nodes,
            edges: persistedGraph.edges,
        };
        const latestSnapshot = pendingHistorySnapshotRef.current || canvasHistoryRef.current.present;
        if (areErdDraftSnapshotsEqual(latestSnapshot, nextSnapshot)) return;
        pendingHistorySnapshotRef.current = nextSnapshot;
        window.clearTimeout(historyTimerRef.current);
        if (!Object.values(historyInteractionRef.current).some(Boolean)) {
            historyTimerRef.current = window.setTimeout(commitPendingHistory, 0);
        }
        refreshHistoryControls();
    }, [commitPendingHistory, isLocalLoadBlocked, persistedGraph, refreshHistoryControls]);

    useEffect(() => () => window.clearTimeout(historyTimerRef.current), []);

    const focusValidationIssue = useCallback((issueItem) => {
        setShowAttributes(true);
        setCollapsedOwners(new Set());
        setFocusId(null);
        setRightOpen(true);
        if (issueItem.nodeId) {
            setSelectedNodeId(issueItem.nodeId);
            setSelectedEdgeId(null);
            setNodes(items => items.map(node => ({ ...node, selected: node.id === issueItem.nodeId })));
            setEdges(items => items.map(edge => ({ ...edge, selected: false })));
        } else if (issueItem.edgeId) {
            setSelectedEdgeId(issueItem.edgeId);
            setSelectedNodeId(null);
            setNodes(items => items.map(node => ({ ...node, selected: false })));
            setEdges(items => items.map(edge => ({ ...edge, selected: edge.id === issueItem.edgeId })));
        }
        window.setTimeout(() => {
            const targetEdge = issueItem.edgeId
                ? edges.find((edge) => edge.id === issueItem.edgeId)
                : null;
            const targetNodes = issueItem.nodeId
                ? [reactFlow.getNode(issueItem.nodeId)].filter(Boolean)
                : targetEdge
                    ? [reactFlow.getNode(targetEdge.source), reactFlow.getNode(targetEdge.target)].filter(Boolean)
                    : [];
            if (targetNodes.length) reactFlow.fitView({ nodes: targetNodes, padding: 0.7, duration: 350, maxZoom: 1.25 });
        }, 0);
    }, [edges, reactFlow]);

    useEffect(() => {
        setIsStartDialogOpen(!activeUuid);
    }, [activeUuid]);

    useEffect(() => {
        const loadSequence = ++localLoadSequenceRef.current;
        // Adopting the UUID returned by our own first save is not a document load.
        // Keep edits and history made since the request; only its payload is saved.
        const created = createdDocumentRef.current;
        createdDocumentRef.current = null;
        if (created?.uuid === activeUuid) {
            return () => { localLoadSequenceRef.current = loadSequence + 1; };
        }
        setShowAttributes(true);
        setShowAttributeCounts(false);
        setCollapsedOwners(new Set());
        setFocusId(null);
        if (!activeUuid) {
            localViewportHydrationRef.current = false;
            setIsLocalLoading(false);
            setLocalLoadError('');
            setIsDocumentReady(true);
            setIsLoadResolved(true);
            resetLocalState();
            return () => { localLoadSequenceRef.current = loadSequence + 1; };
        }

        let cancelled = false;
        historyRecordingRef.current = false;
        localViewportHydrationRef.current = true;
        setDiagramName('ERD Builder');
        setNodes([]);
        setEdges([]);
        setLocalViewport(null);
        clearSelection();
        setLocalLoadError('');
        setIsLocalLoading(true);
        setIsDocumentReady(false);
        setIsLoadResolved(false);
        beginLocalLoad();

        const loadLocalDocument = async () => {
            try {
                const data = getLocalToolDocument(activeUuid, FILE_KINDS.ERD_BUILDER);
                if (cancelled || localLoadSequenceRef.current !== loadSequence) return;

                if (!Array.isArray(data.payload?.nodes) || !Array.isArray(data.payload?.edges)) {
                    throw new Error('Saved Builder document is incomplete');
                }
                const graph = createPersistedDraftGraph(data.payload.nodes, data.payload.edges);
                const loadedViewport = normalizeViewport(data.payload?.viewport);
                const loadedName = data.name || 'Untitled ERD';
                setDiagramName(loadedName);
                setNodes(graph.nodes);
                setEdges(graph.edges);
                setLocalViewport(loadedViewport);
                clearSelection();
                setIsDocumentReady(true);
                setIsLoadResolved(true);

                // React Flow emits viewport changes while restoring the saved canvas.
                // Keep the document in its loading state until that restoration settles,
                // then use the actual viewport as the clean local baseline.
                await new Promise((resolve) => window.setTimeout(resolve, 80));
                if (cancelled || localLoadSequenceRef.current !== loadSequence) return;
                const viewportRestore = loadedViewport
                    ? reactFlow.setViewport(loadedViewport, { duration: 0 })
                    : reactFlow.fitView({ padding: DRAFT_FIT_PADDING, duration: 0 });
                // A renderer transition can be interrupted during route replacement.
                // Never let an unresolved third-party promise strand the loading overlay.
                await Promise.race([
                    Promise.resolve(viewportRestore),
                    new Promise((resolve) => window.setTimeout(resolve, 300)),
                ]);
                await new Promise((resolve) => window.setTimeout(resolve, 32));
                if (cancelled || localLoadSequenceRef.current !== loadSequence) return;

                const hydratedViewport = normalizeViewport(reactFlow.getViewport()) || loadedViewport;
                setLocalViewport(hydratedViewport);
                finishLocalLoad(
                    createLocalDocumentSnapshot(loadedName, {
                        schemaVersion: 3,
                        nodes: graph.nodes,
                        edges: graph.edges,
                        viewport: hydratedViewport,
                    }),
                    );
                resetCanvasHistory(graph.nodes, graph.edges);
                historyRecordingRef.current = true;
                localViewportHydrationRef.current = false;
            } catch (error) {
                if (cancelled || localLoadSequenceRef.current !== loadSequence) return;
                localViewportHydrationRef.current = false;
                setIsLoadResolved(true);
                failLocalLoad();
                const message = error.message || 'Failed to load Builder file';
                setLocalLoadError(message);
                notifyError(message, { title: 'Could not open file' });
            } finally {
                if (!cancelled && localLoadSequenceRef.current === loadSequence) setIsLocalLoading(false);
            }
        };

        loadLocalDocument();
        return () => {
            cancelled = true;
            localLoadSequenceRef.current = loadSequence + 1;
        };
    }, [activeUuid, beginLocalLoad, clearSelection, localLoadAttempt, failLocalLoad, finishLocalLoad, navigate, notifyError, reactFlow, resetCanvasHistory, resetLocalState]);

    const selectEdge = useCallback((edgeId, event, toggle = false) => {
        setSelectedEdgeId(edgeId);
        setSelectedNodeId(null);
        const additive = event?.ctrlKey || event?.metaKey;
        if (!additive) setNodes(items => items.map(node => ({ ...node, selected: false })));
        setEdges(items => items.map(edge => ({ ...edge, selected: edge.id === edgeId ? !(additive && toggle && edge.selected) : Boolean(additive && edge.selected) })));
    }, []);

    const onSelectionChange = useCallback(({ nodes: selectedNodes, edges: selectedEdges }) => {
        setSelectedNodeId(current => selectedNodes.some(node => node.id === current) ? current : selectedNodes.at(-1)?.id || null);
        setSelectedEdgeId(current => selectedEdges.some(edge => edge.id === current) ? current : selectedEdges.at(-1)?.id || null);
    }, []);

    const deleteSelection = useCallback(() => {
        if (isEditingDisabled) return;
        commitPendingHistory();
        const next = removeDraftSelection(nodes, edges);
        setNodes(next.nodes);
        setEdges(next.edges);
        clearSelection();
    }, [clearSelection, commitPendingHistory, edges, isEditingDisabled, nodes]);

    const copySelection = useCallback(() => {
        const fragment = copyDraftSelection(nodes, edges);
        if (!fragment.nodes.length) return;
        clipboardRef.current = fragment;
        pasteCountRef.current = 0;
        setCanPaste(true);
        showToast('Selection copied to Builder clipboard');
    }, [nodes, edges, showToast]);

    const insertFragment = useCallback((fragment, offset) => {
        if (isEditingDisabled || !fragment?.nodes.length) return;
        commitPendingHistory();
        const copied = pasteDraftSelection(fragment, offset);
        const nextNodes = [...nodes.map(node => ({ ...node, selected: false })), ...copied.nodes];
        const nextEdges = [...edges.map(edge => ({ ...edge, selected: false })), ...copied.edges];
        const nextView = revealDraftAttributeGroups(getDraftAttributeTrees(nextNodes, nextEdges), { showAttributes, collapsedOwners }, copied.nodes.map(node => node.id));
        setShowAttributes(nextView.showAttributes);
        setCollapsedOwners(nextView.collapsedOwners);
        setNodes(nextNodes);
        setEdges(nextEdges);
        setSelectedNodeId(copied.nodes[0].id);
        setSelectedEdgeId(null);
    }, [commitPendingHistory, isEditingDisabled, nodes, edges, showAttributes, collapsedOwners]);
    const pasteSelection = useCallback(() => {
        insertFragment(clipboardRef.current, 32 * ++pasteCountRef.current);
    }, [insertFragment]);
    const duplicateSelection = useCallback(() => {
        insertFragment(copyDraftSelection(nodes, edges), 32);
    }, [nodes, edges, insertFragment]);

    useEffect(() => {
        const timer = window.setTimeout(() => setCanvasHintVisible(false), 4200);
        return () => window.clearTimeout(timer);
    }, []);

    useEffect(() => {
        if (typeof window.matchMedia !== 'function') return undefined;
        const compactQuery = window.matchMedia(compactViewportQuery);
        const handleLayoutChange = (event) => {
            if (event.matches) {
                setLeftOpen(false);
                setRightOpen(false);
            }
        };
        compactQuery.addEventListener('change', handleLayoutChange);
        return () => compactQuery.removeEventListener('change', handleLayoutChange);
    }, []);

    useEffect(() => {
        if (!isLayoutMenuOpen) return undefined;
        const closeFromOutside = (event) => {
            if (!layoutMenuRef.current?.contains(event.target)) setIsLayoutMenuOpen(false);
        };
        const closeFromKeyboard = (event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            setIsLayoutMenuOpen(false);
            layoutButtonRef.current?.focus();
        };
        document.addEventListener('pointerdown', closeFromOutside);
        document.addEventListener('keydown', closeFromKeyboard);
        return () => {
            document.removeEventListener('pointerdown', closeFromOutside);
            document.removeEventListener('keydown', closeFromKeyboard);
        };
    }, [isLayoutMenuOpen]);

    useEffect(() => {
        const handleKeyDown = (event) => {
            if (isLocalLoadBlocked || event.defaultPrevented || document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]')) return;
            const element = event.target;
            const isTyping = element instanceof HTMLInputElement
                || element instanceof HTMLTextAreaElement
                || element instanceof HTMLSelectElement
                || element?.isContentEditable
                || Boolean(element?.closest?.('.nokey'));
            const key = event.key.toLowerCase();
            const hasPrimaryModifier = event.ctrlKey || event.metaKey;
            if (!isTyping && hasPrimaryModifier && !event.altKey && (key === 'z' || key === 'y')) {
                const isRedo = key === 'y' || event.shiftKey;
                event.preventDefault();
                if (isRedo) redoCanvas();
                else undoCanvas();
                return;
            }
            if (isEditingDisabled) return;
            if (!isTyping && hasPrimaryModifier && !event.altKey && ['c', 'v', 'd'].includes(key)) {
                if ((key === 'v' && canPaste) || (key !== 'v' && nodes.some(node => node.selected))) {
                    event.preventDefault();
                    if (key === 'c') copySelection();
                    else if (key === 'v') pasteSelection();
                    else duplicateSelection();
                }
                return;
            }
            if (!isTyping && (event.key === 'Delete' || event.key === 'Backspace') && selectionCount) {
                event.preventDefault();
                deleteSelection();
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [canPaste, copySelection, deleteSelection, duplicateSelection, isLocalLoadBlocked, isEditingDisabled, nodes, pasteSelection, redoCanvas, selectionCount, undoCanvas]);

    const onNodesChange = useCallback((changes) => {
        const allowedChanges = isVisualInteractionDisabled
            ? changes.filter((change) => change.type === 'select' || change.type === 'dimensions')
            : changes;
        if (allowedChanges.length) setNodes((items) => {
            const locked = new Set(items.filter(node => node.data?.positionLocked).map(node => node.id));
            return applyNodeChanges(allowedChanges.filter(change => change.type !== 'position' || !locked.has(change.id)), items);
        });
    }, [isVisualInteractionDisabled]);
    const onEdgesChange = useCallback((changes) => {
        const allowedChanges = isEditingDisabled ? changes.filter((change) => change.type === 'select') : changes;
        if (allowedChanges.length) setEdges((items) => applyEdgeChanges(allowedChanges, items));
    }, [isEditingDisabled]);

    const canConnect = useCallback((connection) => {
        if (!connection.source || !connection.target || connection.source === connection.target) return false;
        const source = nodes.find(node => node.id === connection.source);
        const target = nodes.find(node => node.id === connection.target);
        if (!source || !target) return false;
        const existing = reconnectingEdgeRef.current;
        if (existing) return existing.data?.connectionKind === 'annotation' || isDraftSemanticConnection(source.data.shape, target.data.shape);
        return connectionKind === 'annotation' || source.data.shape === 'note' || target.data.shape === 'note'
            || isDraftSemanticConnection(source.data.shape, target.data.shape);
    }, [connectionKind, nodes]);

    const onConnect = useCallback((connection) => {
        if (isEditingDisabled || !canConnect(connection)) return;
        const source = nodes.find(node => node.id === connection.source);
        const target = nodes.find(node => node.id === connection.target);
        const kind = connectionKind === 'annotation' || source.data.shape === 'note' || target.data.shape === 'note' ? 'annotation' : 'semantic';
        setEdges((items) => [...items, normalizeEdge({
            ...connection,
            id: `connector-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            data: { connectionKind: kind, lineStyle: kind === 'annotation' ? 'dashed' : 'solid' },
        })]);
    }, [isEditingDisabled, canConnect, connectionKind, nodes]);

    const onReconnect = useCallback((oldEdge, connection) => {
        if (isEditingDisabled) return;
        if (!connection.source || !connection.target || connection.source === connection.target) return;
        const source = nodes.find(node => node.id === connection.source);
        const target = nodes.find(node => node.id === connection.target);
        if (!source || !target || (oldEdge.data?.connectionKind !== 'annotation' && !isDraftSemanticConnection(source.data.shape, target.data.shape))) return;
        setEdges((items) => reconnectEdge(oldEdge, connection, items, { shouldReplaceId: false }).map((edge) => normalizeEdge(
            edge.id === oldEdge.id ? { ...edge, data: {
                ...edge.data,
                waypoints: [],
                isaRole: edge.source === oldEdge.source && edge.target === oldEdge.target ? edge.data?.isaRole : 'unspecified',
                categoryRole: edge.source === oldEdge.source && edge.target === oldEdge.target ? edge.data?.categoryRole : 'unspecified',
            } } : edge,
        )));
    }, [isEditingDisabled, nodes]);

    const updateEdgeWaypoint = useCallback((edgeId, point) => {
        if (isVisualInteractionDisabled) return;
        setEdges((items) => items.map((edge) => edge.id === edgeId
            ? normalizeEdge({ ...edge, data: { ...edge.data, waypoints: [point] } })
            : edge));
    }, [isVisualInteractionDisabled]);

    const updateEdgeLabelPosition = useCallback((edgeId, field, point) => {
        if (isVisualInteractionDisabled) return;
        setEdges((items) => items.map((edge) => edge.id === edgeId
            ? normalizeEdge({ ...edge, data: { ...edge.data, [field]: point } })
            : edge));
    }, [isVisualInteractionDisabled]);

    const updateEdgeHandle = useCallback((edgeId, field, handle) => {
        if (isVisualInteractionDisabled) return;
        setEdges((items) => items.map((edge) => edge.id === edgeId
            ? normalizeEdge({ ...edge, [field]: handle })
            : edge));
    }, [isVisualInteractionDisabled]);

    const updateSelectedEdgeHandle = (field, handle) => {
        if (!selectedEdgeId || !handleIds.has(handle)) return;
        updateEdgeHandle(selectedEdgeId, field, handle);
    };

    const addShape = useCallback((shape, position) => {
        if (isEditingDisabled) return;
        const canvasBounds = canvasRef.current?.getBoundingClientRect();
        const screenCenter = canvasBounds
            ? {
                x: canvasBounds.left + canvasBounds.width / 2,
                y: canvasBounds.top + canvasBounds.height / 2,
            }
            : { x: window.innerWidth / 2, y: window.innerHeight / 2 };
        const canvasCenter = reactFlow.screenToFlowPosition(screenCenter);
        const size = nodeSize(shape);
        const fallback = {
            x: canvasCenter.x - size.width / 2,
            y: canvasCenter.y - size.height / 2,
        };
        const occupiedRectangles = nodes.map((node) => {
            const existingSize = nodeSize(node.data?.shape || 'entity', node.data?.sizeScale, node.data?.label, node.data?.textScale);
            return { ...node.position, ...existingSize };
        });
        const insertionPosition = position || findOpenNodePosition(fallback, size, occupiedRectangles);
        const nextNode = createDraftNode(shape, insertionPosition);
        setNodes((items) => [...items.map(node => ({ ...node, selected: false })), { ...nextNode, selected: true }]);
        setEdges(items => items.map(edge => ({ ...edge, selected: false })));
        setSelectedNodeId(nextNode.id);
        setSelectedEdgeId(null);
    }, [isEditingDisabled, nodes, reactFlow]);

    const createConnectedShape = useCallback((options) => {
        if (isEditingDisabled) return false;
        const fragment = createConnectedDraftFragment(nodes, options);
        if (!fragment) return false;
        commitPendingHistory();
        const nextNodes = [...nodes.map(node => ({ ...node, selected: node.id === fragment.selectedId })), ...fragment.nodes.map(node => normalizeNode({ ...node, selected: node.id === fragment.selectedId }))];
        const nextEdges = [...edges.map(edge => ({ ...edge, selected: false })), ...fragment.edges.map(edge => withSmartHandles(normalizeEdge(edge), nextNodes))];
        const nextView = revealDraftAttributeGroups(getDraftAttributeTrees(nextNodes, nextEdges), { showAttributes, collapsedOwners }, fragment.nodes.map(node => node.id));
        setShowAttributes(nextView.showAttributes);
        setCollapsedOwners(nextView.collapsedOwners);
        setNodes(nextNodes);
        setEdges(nextEdges);
        setSelectedNodeId(fragment.selectedId);
        setSelectedEdgeId(null);
        const documentAtCreate = localLoadSequenceRef.current;
        window.setTimeout(() => {
            if (documentAtCreate === localLoadSequenceRef.current) reactFlow.fitView({ nodes: nextNodes.filter(node => node.id === options.ownerId || fragment.nodes.some(added => added.id === node.id) || node.id === options.targetId), padding: 0.4, duration: 250, maxZoom: 1 });
        }, 0);
        return true;
    }, [commitPendingHistory, edges, isEditingDisabled, nodes, reactFlow, showAttributes, collapsedOwners]);

    const onDrop = useCallback((event) => {
        event.preventDefault();
        if (isEditingDisabled) return;
        const shape = event.dataTransfer.getData('application/erdgo-draft');
        if (!shape) return;
        addShape(shape, reactFlow.screenToFlowPosition({ x: event.clientX, y: event.clientY }));
    }, [addShape, isEditingDisabled, reactFlow]);

    const startPalettePointerDrag = (event, shape) => {
        if (isEditingDisabled) return;
        // A new pointer gesture can always click, even if the previous drag had no click.
        suppressPaletteClickRef.current = false;
        if (event.pointerType === 'mouse') return;
        palettePointerDragRef.current = {
            pointerId: event.pointerId,
            shape,
            startX: event.clientX,
            startY: event.clientY,
            moved: false,
        };
        event.currentTarget.setPointerCapture?.(event.pointerId);
    };

    const movePalettePointerDrag = (event) => {
        const drag = palettePointerDragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        const deltaX = event.clientX - drag.startX;
        const deltaY = event.clientY - drag.startY;
        if (!drag.moved && (Math.abs(deltaY) > Math.abs(deltaX) || Math.hypot(deltaX, deltaY) < 8)) return;
        drag.moved = true;
        event.preventDefault();
        setLeftOpen(false);
        setPalettePointerDrag({ shape: drag.shape, x: event.clientX, y: event.clientY });
    };

    const finishPalettePointerDrag = (event) => {
        const drag = palettePointerDragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        palettePointerDragRef.current = null;
        setPalettePointerDrag(null);
        if (!drag.moved) return;
        // Touch browsers can synthesize a click after pointerup on the captured item.
        suppressPaletteClickRef.current = true;
        const bounds = canvasRef.current?.getBoundingClientRect();
        if (!bounds || event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) return;
        const center = reactFlow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
        const size = nodeSize(drag.shape);
        addShape(drag.shape, { x: center.x - size.width / 2, y: center.y - size.height / 2 });
    };

    const cancelPalettePointerDrag = () => {
        palettePointerDragRef.current = null;
        setPalettePointerDrag(null);
    };

    const clickPaletteShape = (shape) => {
        if (suppressPaletteClickRef.current) {
            suppressPaletteClickRef.current = false;
            return;
        }
        if (isEditingDisabled) return;
        addShape(shape);
        if (isCompactViewport()) setLeftOpen(false);
    };

    const openShapeLibrary = () => {
        if (isCompactViewport()) setRightOpen(false);
        setLeftOpen(true);
    };

    const openInspector = () => {
        if (isCompactViewport()) setLeftOpen(false);
        setRightOpen(true);
    };

    const updateNodeData = (field, value) => {
        const changes = typeof field === 'object' ? field : { [field]: value };
        const isVisualOnly = Object.keys(changes).every((key) => key === 'sizeScale' || key === 'textScale');
        if (isLocalLoading || (isReadOnlyLocalFile && !isVisualOnly) || !selectedNodeId) return;
        setNodes((items) => items.map((node) => node.id === selectedNodeId
            ? normalizeNode({ ...node, data: {
                ...node.data,
                ...changes,
                ...(node.data.shape === 'isa' && typeof changes.label === 'string' ? { showLabel: Boolean(changes.label.trim()) } : {}),
            } })
            : node));
    };

    const updateNodeLabel = useCallback((nodeId, label) => {
        if (isEditingDisabled) return;
        setNodes((items) => items.map((node) => node.id === nodeId
            ? normalizeNode({ ...node, data: { ...node.data, label, ...(node.data.shape === 'isa' ? { showLabel: Boolean(label.trim()) } : {}) } })
            : node));
    }, [isEditingDisabled]);

    const nodeContextValue = useMemo(() => ({
        readOnly: isEditingDisabled,
        onLabelChange: updateNodeLabel,
        connectionSourceId,
        canConnect,
        attributesByOwner: attributeTrees.attributesByOwner,
        showAttributes,
        showAttributeCounts,
        collapsedOwners,
        onToggleAttributes: (ownerId) => {
            if (isLocalLoadBlocked) return;
            if (!showAttributes) {
                setShowAttributes(true);
                setCollapsedOwners(new Set([...attributeTrees.attributesByOwner.keys()].filter(id => id !== ownerId)));
            } else setCollapsedOwners(items => {
                const next = new Set(items);
                if (next.has(ownerId)) next.delete(ownerId); else next.add(ownerId);
                return next;
            });
        },
    }), [isEditingDisabled, updateNodeLabel, connectionSourceId, canConnect, attributeTrees, showAttributes, showAttributeCounts, collapsedOwners, isLocalLoadBlocked]);

    const changeNodeShape = (shape) => {
        if (isEditingDisabled || !selectedNodeId) return;
        if (selectedNode?.data.shape === shape) return;
        const catalogItem = shapeCatalog.find((item) => item.type === shape);
        // Roles belong to the endpoint types that were reviewed, not a later replacement shape.
        setEdges((items) => items.map((edge) => edge.source === selectedNodeId || edge.target === selectedNodeId
            ? { ...edge, data: { ...edge.data, isaRole: 'unspecified', categoryRole: 'unspecified' } }
            : edge));
        setNodes((items) => items.map((node) => node.id === selectedNodeId
            ? normalizeNode({ ...node, data: { ...node.data, shape, color: catalogItem?.color || node.data.color } })
            : node));
    };

    const updateEdgeData = (field, value) => {
        const changes = typeof field === 'object' ? field : { [field]: value };
        const isVisualOnly = Object.keys(changes).every((key) => ['waypoints', 'sourceLabelPosition', 'targetLabelPosition'].includes(key));
        if (isLocalLoading || (isReadOnlyLocalFile && !isVisualOnly) || !selectedEdgeId) return;
        setEdges((items) => items.map((edge) => edge.id === selectedEdgeId
            ? normalizeEdge({ ...edge, data: { ...edge.data, ...changes } })
            : edge));
    };

    const updateEdgeEndpoint = (field, value) => {
        if (isEditingDisabled || !selectedEdge || selectedEdge[field] === value) return;
        const nextSource = field === 'source' ? value : selectedEdge.source;
        const nextTarget = field === 'target' ? value : selectedEdge.target;
        if (nextSource === nextTarget) {
            showToast('A connector needs two different shapes');
            return;
        }
        const relationshipRoleEnds = relationshipRoleEndsForEdge(nextSource, nextTarget, nodes);
        setEdges((items) => items.map((edge) => edge.id === selectedEdge.id
            ? withSmartHandles(normalizeEdge({
                ...edge,
                [field]: value,
                [field === 'source' ? 'sourceHandle' : 'targetHandle']: null,
                data: {
                    ...edge.data,
                    waypoints: [],
                    isaRole: 'unspecified',
                    categoryRole: 'unspecified',
                    sourceCardinalityEnabled: relationshipRoleEnds.includes('source'),
                    targetCardinalityEnabled: relationshipRoleEnds.includes('target'),
                },
            }), nodes)
            : edge));
    };

    const loadTemplate = useCallback((template, { resetHistory = false } = {}) => {
        if (isEditingDisabled) return;
        const graph = graphFromTemplate(template);
        setDiagramName(graph.name);
        setNodes(graph.nodes);
        setEdges(graph.edges);
        setTemplateBaseline(createDraftContentSnapshot(graph.name, graph.nodes, graph.edges));
        if (resetHistory) {
            resetCanvasHistory(graph.nodes, graph.edges);
            historyRecordingRef.current = true;
        }
        clearSelection();
        setShowAttributes(true);
        setShowAttributeCounts(false);
        setCollapsedOwners(new Set());
        setFocusId(null);
        if (graph.nodes.length) {
            window.setTimeout(() => {
                reactFlow.fitView({ padding: DRAFT_FIT_PADDING, duration: 550 });
            }, 80);
        } else {
            // Settle before the first insertion; a delayed reset can move a newly added shape offscreen.
            reactFlow.setViewport({ x: 0, y: 0, zoom: 1 }, { duration: 0 });
        }
    }, [clearSelection, isEditingDisabled, reactFlow, resetCanvasHistory]);

    const requestTemplateLoad = useCallback(async (template) => {
        if (isEditingDisabled) return;
        const hasReplacementRisk = Boolean(activeUuid)
            || currentDraftContentSnapshot !== templateBaseline;
        if (hasReplacementRisk) {
            const confirmed = await confirm({
                title: 'Replace current canvas?',
                message: `This will replace every shape and connector with the ${template.id === 'blank' ? 'blank canvas' : 'healthcare example'}. Save your current work first if you want to keep it.`,
                confirmText: 'Replace canvas',
                tone: 'danger',
            });
            if (!confirmed) return;
        }
        loadTemplate(template);
    }, [activeUuid, confirm, currentDraftContentSnapshot, isEditingDisabled, loadTemplate, templateBaseline]);

    const handleStartWithSample = () => {
        loadTemplate(healthcareDraft, { resetHistory: true });
        setIsStartDialogOpen(false);
    };

    const handleStartBlank = () => {
        loadTemplate(blankDraft, { resetHistory: true });
        setIsStartDialogOpen(false);
    };

    const focusFirstLayoutOption = () => {
        window.setTimeout(() => layoutMenuRef.current?.querySelector('[role="menuitem"]')?.focus(), 0);
    };

    const handleLayoutMenuKeyDown = (event) => {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        const items = [...(layoutMenuRef.current?.querySelectorAll('[role="menuitem"]') || [])];
        if (!items.length) return;
        event.preventDefault();
        const currentIndex = items.indexOf(document.activeElement);
        if (event.key === 'Home') items[0].focus();
        else if (event.key === 'End') items[items.length - 1].focus();
        else if (event.key === 'ArrowDown') items[(currentIndex + 1 + items.length) % items.length].focus();
        else items[currentIndex <= 0 ? items.length - 1 : currentIndex - 1].focus();
    };

    const autoLayout = async (layoutMode = ERD_DRAFT_LAYOUT_MODES.SMART) => {
        if (isVisualInteractionDisabled || isLayoutRunning || !nodes.length) return;
        const plan = getErdDraftLayoutPlan(layoutMode, nodes, edges);
        const contentAtStart = currentDraftContentSnapshot;
        const documentAtStart = localLoadSequenceRef.current;
        setIsLayoutMenuOpen(false);
        setIsLayoutRunning(true);
        try {
            const chenGraph = plan.resolvedMode === ERD_DRAFT_LAYOUT_MODES.CHEN ? createChenDraftLayoutGraph(nodes, edges) : null;
            const graph = await layoutGraph({
                id: 'erd-draft-root',
                layoutOptions: plan.layoutOptions,
                children: chenGraph?.children || nodes.map((item) => ({ id: item.id, ...nodeSize(item.data.shape, item.data.sizeScale, item.data.label, item.data.textScale) })),
                edges: chenGraph?.edges || draftLayoutEdges(nodes, edges),
            });
            if (documentAtStart !== localLoadSequenceRef.current) return;
            if (contentAtStart !== latestContentRef.current) {
                showToast('Diagram changed during layout. Arrange again to use the latest edits.');
                return;
            }
            commitPendingHistory();
            const positions = new Map(graph.children?.map((item) => [item.id, { x: item.x || 0, y: item.y || 0 }]) || []);
            const lockedIds = new Set(nodes.filter(node => node.data?.positionLocked).map(node => node.id));
            const laidOutNodes = chenGraph ? applyChenDraftLayout(nodes, chenGraph, graph) : nodes.map((item) => ({ ...item, position: lockedIds.has(item.id) ? item.position : positions.get(item.id) || item.position }));
            const repeatedParticipationIds = getDraftRepeatedParticipationIds(nodes, edges);
            const laidOutEdges = separateDraftParticipationPaths(laidOutNodes, edges.map((edge) => lockedIds.has(edge.source) || lockedIds.has(edge.target) || repeatedParticipationIds.has(edge.id) ? edge : withSmartHandles(normalizeEdge({
                ...edge,
                sourceHandle: null,
                targetHandle: null,
                data: { ...edge.data, waypoints: [] },
            }), laidOutNodes)));
            setNodes(items => {
                const selection = new Set(items.filter(item => item.selected).map(item => item.id));
                return laidOutNodes.map(node => ({ ...node, selected: selection.has(node.id) }));
            });
            setEdges(items => {
                const selection = new Set(items.filter(item => item.selected).map(item => item.id));
                return laidOutEdges.map(edge => ({ ...edge, selected: selection.has(edge.id) }));
            });
            setLastLayoutMode(plan.requestedMode);
            window.setTimeout(() => {
                if (documentAtStart === localLoadSequenceRef.current) reactFlow.fitView({ padding: DRAFT_FIT_PADDING, duration: 650 });
            }, 80);
        } catch {
            if (documentAtStart === localLoadSequenceRef.current) showToast('Auto layout could not arrange this diagram');
        } finally {
            setIsLayoutRunning(false);
        }
    };

    const performLocalSave = useCallback(async () => {
        if (activeUuid && !isDocumentReady) return;
        const normalizedName = diagramName.trim();
        if (normalizedName.length < 3 || normalizedName.length > 259) {
            notifyError('Use a file name between 3 and 259 characters.', { title: 'Cannot save yet' });
            return;
        }

        if (!beginLocalSave()) return;
        const documentAtStart = localLoadSequenceRef.current;
        try {
            const viewportAtSaveStart = localViewport;
            const currentViewport = normalizeViewport(reactFlow.getViewport());
            const payload = {
                schemaVersion: 3,
                nodes: clone(persistedGraph.nodes),
                edges: clone(persistedGraph.edges),
                viewport: currentViewport,
            };
            const shouldCreate = !activeUuid;
            const saved = saveLocalDocument({
                id: activeUuid, kind: FILE_KINDS.ERD_BUILDER, name: normalizedName, payload,
            });

            if (documentAtStart !== localLoadSequenceRef.current) { failLocalSave(); return; }

            if (shouldCreate && !saved?.id) {
                throw new Error('Local save did not return a file identifier');
            }
            setIsDocumentReady(true);
            finishLocalSave(
                createLocalDocumentSnapshot(normalizedName, {
                    schemaVersion: 3,
                    nodes: payload.nodes,
                    edges: payload.edges,
                    viewport: payload.viewport,
                }),
            );
            // Reconcile an idle camera with the exact saved viewport, but never
            // overwrite a pan or zoom that happened while the request was active.
            setLocalViewport((latestViewport) => (
                sameViewport(latestViewport, viewportAtSaveStart) ? currentViewport : latestViewport
            ));
            showToast('Diagram saved locally');

            if (shouldCreate && saved?.id) {
                createdDocumentRef.current = { uuid: saved.id };
                navigate(`/erd-builder/${saved.id}`, { replace: true });
            }
        } catch (error) {
            failLocalSave();
            if (documentAtStart !== localLoadSequenceRef.current) return;
            notifyError(error.message || 'Failed to save Builder file', { title: 'Local save failed' });
        }
    }, [activeUuid, beginLocalSave, localViewport, diagramName, failLocalSave, finishLocalSave, isDocumentReady, navigate, notifyError, persistedGraph, reactFlow, showToast]);

    const handleLocalSave = useCallback(() => { void performLocalSave(); }, [performLocalSave]);

    const handleOpenLocalFiles = useCallback(() => {
        openTypedFileList({ fileKind: FILE_KINDS.ERD_BUILDER, routeBase: '/erd-builder' });
    }, [openTypedFileList]);

    const isLocalSaveDisabled = isLocalSaving
        || isLocalLoadBlocked
        || !hasUnsavedChanges;
    const canUndoCanvas = !isLocalLoadBlocked && historyControls.canUndo;
    const canRedoCanvas = !isLocalLoadBlocked && historyControls.canRedo;

    return (
        <main
            onPointerDownCapture={(event) => { if (event.button === 0) beginHistoryInteraction('pointer'); }}
            onFocusCapture={(event) => {
                if (event.target.matches('textarea, input:not([type=checkbox]):not([type=radio]):not([type=range])')) beginHistoryInteraction('field');
            }}
            onBlurCapture={(event) => {
                if (event.target.matches('textarea, input:not([type=checkbox]):not([type=radio]):not([type=range])')) endHistoryInteraction('field');
            }}
            onKeyDownCapture={(event) => {
                if (event.key.startsWith('Arrow') && !event.target.matches('input, textarea, select') && !event.target.closest('.nokey')) beginHistoryInteraction('keyboard');
            }}
            className={`erd-draft-app${isShapeLibraryOpen ? '' : ' left-closed'}${rightOpen ? '' : ' right-closed'}${isReadOnlyLocalFile ? ' is-read-only' : ''}${isMinimapOpen ? ' minimap-open' : ''}`}>
            <header className="erd-draft-topbar">
                <div className="erd-draft-brand">
                    <Link to="/" aria-label="Back to Erd Go"><HomeIcon /></Link>
                    <h1 className="erd-draft-brand-name">Erd Builder</h1>
                </div>
                <div className="erd-draft-topbar-actions">
                    <div className="erd-draft-title">
                        <input aria-label="Diagram name" value={diagramName} onChange={(event) => setDiagramName(event.target.value)} readOnly={isEditingDisabled} />
                        {(!activeUuid || isDocumentReady) && (
                            <button
                                type="button"
                                className={`erd-draft-save-button${isLocalSaveDisabled ? ' disabled' : ''}`}
                                onClick={handleLocalSave}
                                disabled={isLocalSaveDisabled}
                                title="Save ERD Builder file locally"
                                aria-label="Save ERD Builder file locally"
                            >
                                {isLocalSaving ? <span className="save-spinner" /> : <Save size={18} />}
                            </button>
                        )}
                    </div>
                    <button
                        type="button"
                        className="erd-draft-files-button"
                        onClick={handleOpenLocalFiles}
                        title="Open Builder files"
                        aria-label="Open Builder files"
                    >
                        <ListIcon />
                    </button>
                    <button
                        type="button"
                        className="erd-draft-history-button"
                        onClick={undoCanvas}
                        disabled={!canUndoCanvas}
                        title="Undo canvas change (Ctrl/Cmd+Z)"
                        aria-label="Undo canvas change"
                        aria-keyshortcuts="Control+Z Meta+Z"
                    >
                        <Undo2 size={18} />
                    </button>
                    <button
                        type="button"
                        className="erd-draft-history-button"
                        onClick={redoCanvas}
                        disabled={!canRedoCanvas}
                        title="Redo canvas change (Ctrl/Cmd+Y or Ctrl/Cmd+Shift+Z)"
                        aria-label="Redo canvas change"
                        aria-keyshortcuts="Control+Y Meta+Y Control+Shift+Z Meta+Shift+Z"
                    >
                        <Redo2 size={18} />
                    </button>
                    {!isLocalLoadBlocked && (
                        <div className="erd-draft-layout-control" ref={layoutMenuRef}>
                            <button
                                ref={layoutButtonRef}
                                type="button"
                                className={`erd-draft-auto-layout-button${isLayoutMenuOpen ? ' active' : ''}`}
                                onClick={() => setIsLayoutMenuOpen((open) => !open)}
                                onKeyDown={(event) => {
                                    if (event.key !== 'ArrowDown') return;
                                    event.preventDefault();
                                    setIsLayoutMenuOpen(true);
                                    focusFirstLayoutOption();
                                }}
                                disabled={isLayoutRunning || nodes.length === 0}
                                title="Arrange diagram"
                                aria-label="Arrange diagram"
                                aria-haspopup="menu"
                                aria-expanded={isLayoutMenuOpen}
                            >
                                <LayoutGrid size={18} />
                                <ChevronDown className="erd-draft-layout-chevron" size={10} />
                            </button>
                            {isLayoutMenuOpen && (
                                <div className="erd-draft-layout-menu" role="menu" aria-label="Diagram arrangement" onKeyDown={handleLayoutMenuKeyDown}>
                                    <div className="erd-draft-layout-menu-heading">
                                        <b>Arrange diagram</b>
                                        <span>Every arrangement can be undone</span>
                                    </div>
                                    {ERD_DRAFT_LAYOUT_OPTIONS.map((option) => (
                                        <button
                                            key={option.mode}
                                            type="button"
                                            role="menuitem"
                                            className={lastLayoutMode === option.mode ? 'active' : ''}
                                            onClick={() => autoLayout(option.mode)}
                                        >
                                            <span className="erd-draft-layout-badge">{option.badge}</span>
                                            <span><b>{option.title}</b><small>{option.note}</small></span>
                                            {lastLayoutMode === option.mode && <Check size={15} />}
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}
                    <button
                        type="button"
                        className={`erd-draft-minimap-toggle-button${isMinimapOpen ? ' active' : ''}`}
                        title={isMinimapOpen ? 'Hide ERD minimap' : 'Show ERD minimap'}
                        aria-label={isMinimapOpen ? 'Hide ERD minimap' : 'Show ERD minimap'}
                        aria-pressed={isMinimapOpen}
                        disabled={isLocalLoadBlocked || nodes.length === 0}
                        onClick={() => setIsMinimapOpen((open) => !open)}
                    >
                        <svg className="erd-draft-minimap-toggle-icon" width="24" height="24" viewBox="3 0 26 28" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <ellipse cx="16" cy="9.5" rx="8.25" ry="6.9" />
                            <line x1="16" y1="16.4" x2="16" y2="26.2" />
                        </svg>
                    </button>
                    <button
                        type="button"
                        className="erd-draft-export-button"
                        title="Export diagram"
                        aria-label="Export diagram"
                        aria-haspopup="dialog"
                        aria-expanded={isExportOpen}
                        disabled={isLocalLoadBlocked || nodes.length === 0}
                        onClick={() => setIsExportOpen(true)}
                    >
                        <Download size={18} />
                    </button>
                    <button type="button" className="erd-draft-sql-button" title="Convert ERD to SQL" aria-label="Convert ERD to SQL" aria-haspopup="dialog" aria-expanded={Boolean(sqlExportGraph)}
                        disabled={isLocalLoadBlocked || isStartDialogOpen || !nodes.some(node => isDraftEntityShape(node.data?.shape))}
                        onClick={() => setSqlExportGraph(clone({ name: diagramName, ...persistedGraph }))}>
                        <Code2 size={18} /><span>SQL</span>
                    </button>
                    <button className="erd-draft-icon-button" aria-label="Toggle theme" title="Toggle theme" onClick={toggleTheme}>{isDark ? <Sun size={17} /> : <Moon size={17} />}</button>
                </div>
            </header>

            {!isReadOnlyLocalFile && <aside className="erd-draft-library">
                <div className="erd-draft-panel-heading">
                    <div><span>ERD shapes</span><small>Click, drag, or press Enter to add</small></div>
                    <button className="erd-draft-icon-button compact" aria-label="Collapse shape library" onClick={() => setLeftOpen(false)}><ChevronLeft size={18} /></button>
                </div>
                <div className="erd-draft-panel-scroll">
                    <section className="erd-draft-template-section">
                        <div className="erd-draft-section-label"><span>Start from</span></div>
                        <div className="erd-draft-template-grid">
                            {draftTemplates.map((template) => (
                                <button key={template.id} onClick={() => requestTemplateLoad(template)}>
                                    {template.id === 'blank' ? <Sparkles size={16} /> : <Shapes size={16} />}
                                    <span><b>{template.id === 'blank' ? 'Blank canvas' : 'Healthcare example'}</b><small>{template.nodes.length} shapes</small></span>
                                </button>
                            ))}
                        </div>
                    </section>
                    <section>
                        <div className="erd-draft-section-label"><span>Chen &amp; EER notation</span><small>{shapeCatalog.length}</small></div>
                        {shapeGroups.map((group) => (
                            <div className="erd-draft-shape-group" key={group.name}>
                                <small className="erd-draft-shape-group-label">{group.name}</small>
                                <div className="erd-draft-shape-list">
                                    {group.shapes.map((shape) => {
                                        const Icon = shapeIcons[shape.type] || Box;
                                        return (
                                            <div
                                                key={shape.type}
                                                className="erd-draft-shape-item"
                                                role="button"
                                                tabIndex={isEditingDisabled ? -1 : 0}
                                                aria-disabled={isEditingDisabled}
                                                aria-label={`Add ${shape.label}`}
                                                draggable={!isEditingDisabled}
                                                onClick={() => clickPaletteShape(shape.type)}
                                                onKeyDown={(event) => {
                                                    if (event.key !== 'Enter' && event.key !== ' ') return;
                                                    event.preventDefault();
                                                    addShape(shape.type);
                                                }}
                                                onDragStart={(event) => {
                                                    if (isEditingDisabled) {
                                                        event.preventDefault();
                                                        return;
                                                    }
                                                    suppressPaletteClickRef.current = true;
                                                    event.dataTransfer.setData('application/erdgo-draft', shape.type);
                                                    event.dataTransfer.effectAllowed = 'move';
                                                }}
                                                onPointerDown={(event) => startPalettePointerDrag(event, shape.type)}
                                                onPointerMove={movePalettePointerDrag}
                                                onPointerUp={finishPalettePointerDrag}
                                                onPointerCancel={cancelPalettePointerDrag}
                                            >
                                                <span className={`erd-draft-shape-icon erd-draft-shape-icon--${shape.type}`} style={{ '--shape-color': shape.color }}><Icon size={16} /></span>
                                                <span><b>{shape.label}</b><small>{shape.hint}</small></span>
                                                <i aria-hidden="true"><GripVertical size={14} /></i>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        ))}
                    </section>
                </div>
                <div className="erd-draft-connection-mode">
                    <Field label="New connector type">
                        <select value={connectionKind} onChange={event => setConnectionKind(event.target.value)}>
                            <option value="semantic">Model relationship</option>
                            <option value="annotation">Annotation only</option>
                        </select>
                    </Field>
                </div>
                <div className="erd-draft-panel-tip"><Route size={14} /><span>Drag between highlighted shapes to connect. Notes create annotation lines. Drag a connector to curve it.</span></div>
            </aside>}

            <section
                className="erd-draft-canvas"
                ref={canvasRef}
                onDrop={onDrop}
                onDragOver={(event) => {
                    if (isEditingDisabled) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = 'move';
                }}
            >
                {!isReadOnlyLocalFile && !leftOpen && <button className="erd-draft-panel-toggle left" onClick={openShapeLibrary}><Shapes size={16} /> Shapes</button>}
                {!rightOpen && <button className="erd-draft-panel-toggle right" onClick={openInspector}><ChevronLeft size={16} /> Inspector</button>}
                <ErdDraftNodeContext.Provider value={nodeContextValue}>
                    <ErdDraftEdgeContext.Provider value={{ readOnly: isVisualInteractionDisabled, onSelectEdge: selectEdge, onWaypointChange: updateEdgeWaypoint, onLabelPositionChange: updateEdgeLabelPosition, onEndpointHandleChange: updateEdgeHandle, dimmedEdges: canvasView.dimmedEdges }}>
                        <ReactFlow
                        nodes={displayNodes}
                        edges={displayEdges}
                        nodeTypes={nodeTypes}
                        edgeTypes={edgeTypes}
                        onNodesChange={onNodesChange}
                        onEdgesChange={onEdgesChange}
                        onConnect={onConnect}
                        onReconnect={onReconnect}
                        onReconnectStart={(_event, edge) => { reconnectingEdgeRef.current = edge; }}
                        onReconnectEnd={() => { reconnectingEdgeRef.current = null; setConnectionSourceId(null); }}
                        isValidConnection={canConnect}
                        onConnectStart={(_event, { nodeId }) => setConnectionSourceId(nodeId)}
                        onConnectEnd={() => setConnectionSourceId(null)}
                        onNodeClick={(_event, node) => { setSelectedNodeId(node.id); setSelectedEdgeId(null); }}
                        onSelectionChange={onSelectionChange}
                        onPaneClick={clearSelection}
                        onMoveEnd={(_event, viewport) => {
                            if (!isVisualInteractionDisabled && !localViewportHydrationRef.current) {
                                setLocalViewport(normalizeViewport(viewport));
                            }
                        }}
                        connectionMode={ConnectionMode.Loose}
                        connectionRadius={42}
                        reconnectRadius={20}
                        nodesDraggable={!isVisualInteractionDisabled}
                        nodesConnectable={!isEditingDisabled}
                        edgesReconnectable={!isEditingDisabled}
                        elevateEdgesOnSelect={false}
                        elevateNodesOnSelect={false}
                        deleteKeyCode={null}
                        multiSelectionKeyCode={['Meta', 'Control']}
                        defaultViewport={initialGraph.viewport || { x: 0, y: 0, zoom: 1 }}
                        fitView={!activeUuid && !initialGraph.viewport}
                        fitViewOptions={{ padding: DRAFT_FIT_PADDING }}
                        minZoom={DRAFT_MIN_ZOOM}
                        maxZoom={DRAFT_MAX_ZOOM}
                        proOptions={{ hideAttribution: true }}
                    >
                        <Background variant={BackgroundVariant.Dots} gap={22} size={1.15} color="var(--draft-grid-dot)" />
                        <Panel position="top-right" className="erd-draft-view-panel">
                            <DraftCanvasViewTools
                                showAttributes={hasVisibleAttributes}
                                onShowAttributes={value => { setShowAttributes(value); setCollapsedOwners(new Set()); }}
                                showAttributeCounts={showAttributeCounts}
                                onShowAttributeCounts={setShowAttributeCounts}
                                focusId={canvasView.focused ? focusId : null}
                                focusName={inspectorNodeName(nodes.find(node => node.id === focusId))}
                                selectedNode={selectedNode}
                                history={isReadOnlyLocalFile ? null : { canUndo: canUndoCanvas, canRedo: canRedoCanvas, onUndo: undoCanvas, onRedo: redoCanvas }}
                                onFocus={setFocusId}
                                blocked={isLocalLoadBlocked}
                                hasAttributes={attributeTrees.ownerByAttribute.size > 0}
                            />
                        </Panel>
                        <Controls position="bottom-right" showInteractive={false} fitViewOptions={{ padding: DRAFT_FIT_PADDING }} />
                        <MiniMap
                            className={`erd-draft-minimap${isMinimapOpen ? ' is-open' : ''}`}
                            position="bottom-left"
                            style={{ width: 180, height: 108 }}
                            pannable
                            zoomable
                            ariaLabel="ERD Builder minimap. Click to move, drag to pan, or scroll to zoom."
                            nodeColor={(node) => node.data.color || '#2389dd'}
                            nodeStrokeColor={(node) => node.selected ? 'var(--draft-minimap-selected)' : 'var(--draft-minimap-node-stroke)'}
                            nodeStrokeWidth={1.2}
                            nodeBorderRadius={1.8}
                            bgColor="var(--draft-minimap-background)"
                            maskColor="var(--draft-minimap-mask)"
                            maskStrokeColor="var(--draft-minimap-viewport)"
                            maskStrokeWidth={1.35}
                        />
                        <Panel position="bottom-center" className="erd-draft-canvas-status">
                            <span><b>{stats.entities}</b> entities</span><i /><span><b>{stats.relationships}</b> relationships</span><i /><span><b>{stats.attributes}</b> attributes</span>
                            <i />
                            <button
                                className={!nodes.length ? 'is-empty' : validationIssues.length ? 'has-issues' : 'is-valid'}
                                onClick={() => setRightOpen(true)}
                                aria-label={!nodes.length ? 'No model checks yet' : `${validationIssues.length} model ${validationIssues.length === 1 ? 'issue' : 'issues'}`}
                            >
                                {!nodes.length ? 'No checks yet' : validationIssues.length ? `${validationIssues.length} issues` : 'No issues found'}
                            </button>
                        </Panel>
                        </ReactFlow>
                    </ErdDraftEdgeContext.Provider>
                </ErdDraftNodeContext.Provider>
                {!nodes.length && !isReadOnlyLocalFile && (
                    <div className="erd-draft-empty">
                        <span><Shapes size={25} /></span>
                        <h2>Sketch your first ERD</h2>
                        <p>Add an entity, a relationship, and a few attributes. Connectors snap to every side.</p>
                        <button onClick={() => addShape('entity')}><Box size={16} /> Add an entity</button>
                    </div>
                )}
            </section>

            <aside className="erd-draft-inspector">
                <div className="erd-draft-panel-heading">
                    <div><span>Inspector</span><small>{isReadOnlyLocalFile ? 'View and resize the selection' : 'Edit the selection'}</small></div>
                    <button className="erd-draft-icon-button compact" aria-label="Collapse inspector" onClick={() => setRightOpen(false)}><ChevronRight size={18} /></button>
                </div>
                <DraftSelectionTools
                    nodes={nodes} selectionCount={selectionCount} canPaste={canPaste}
                    readOnly={isReadOnlyLocalFile} blocked={isLocalLoadBlocked}
                    onCopy={copySelection} onPaste={pasteSelection} onDuplicate={duplicateSelection} onDelete={deleteSelection}
                    onArrange={mode => { if (!isEditingDisabled) { commitPendingHistory(); setNodes(items => arrangeDraftSelection(items, mode)); } }}
                    onLock={locked => { if (!isEditingDisabled) { commitPendingHistory(); setNodes(items => items.map(node => node.selected ? { ...node, data: { ...node.data, positionLocked: locked } } : node)); } }}
                    onFocus={nodeId => focusValidationIssue({ nodeId })}
                />
                <DraftValidationSummary issues={validationIssues} hasModel={nodes.length > 0} onFocusIssue={focusValidationIssue} />
                <DraftInspector
                    node={selectedNode}
                    edge={selectedEdge}
                    nodes={nodes}
                    onNodeChange={updateNodeData}
                    onShapeChange={changeNodeShape}
                    onEdgeChange={updateEdgeData}
                    onEdgeEndpointChange={updateEdgeEndpoint}
                    onEdgeHandleChange={updateSelectedEdgeHandle}
                    onDelete={deleteSelection}
                    selectionCount={selectionCount}
                    onAddEntity={() => addShape('entity')}
                    onCreateConnected={createConnectedShape}
                    readOnly={isEditingDisabled}
                    allowVisualChanges={!isVisualInteractionDisabled}
                />
            </aside>
            {(isShapeLibraryOpen || rightOpen) && (
                <button
                    className={`erd-draft-mobile-scrim ${isShapeLibraryOpen ? 'left-open' : 'right-open'}`}
                    aria-label="Close side panels"
                    onClick={() => { setLeftOpen(false); setRightOpen(false); }}
                />
            )}
            {palettePointerDrag && (
                <div className="erd-draft-palette-drag-preview" style={{ left: palettePointerDrag.x, top: palettePointerDrag.y }}>
                    {shapeCatalog.find((shape) => shape.type === palettePointerDrag.shape)?.label || 'ERD shape'}
                </div>
            )}
            {canvasHintVisible && (
                <div className="erd-draft-canvas-hint"><MousePointer2 size={14} /><span>Drag shapes · drag connectors to curve · scroll to zoom</span></div>
            )}
            {toast && <div className="erd-draft-toast"><Check size={15} /> {toast}</div>}
            <CreateNewFileDialog
                isDisplay={isStartDialogOpen}
                onSelectSample={handleStartWithSample}
                onSelectBlank={handleStartBlank}
                title="Create New ERD Builder File"
                sampleTitle="Create with Healthcare Sample"
                sampleDescription="Explore a complete Chen-notation healthcare diagram"
                blankTitle="Create Empty ERD"
                blankDescription="Start with a clean canvas and add your own shapes"
            />
            <LocalDocumentLoadState
                toolLabel="ERD Builder"
                isLoading={isLocalLoading && Boolean(activeUuid)}
                error={localLoadError}
                onRetry={() => setLocalLoadAttempt((value) => value + 1)}
                onOpenFiles={handleOpenLocalFiles}
            />
            {isExportOpen && <ErdExportDialog erdRendering={exportRendering} onClose={() => setIsExportOpen(false)} />}
            {sqlExportGraph && <DraftSqlExportDialog graph={sqlExportGraph} onClose={() => setSqlExportGraph(null)}
                onOpenEditor={document => runAfterNavigationConfirm(() => navigate('/e/new', { state: { sqlEditorTransfer: { version: 1, ...document } } }))} />}
        </main>
    );
}

function DraftValidationSummary({ issues, hasModel, onFocusIssue }) {
    const errorCount = issues.filter((item) => item.level === 'error').length;
    return (
        <details className={`erd-draft-validation${!hasModel ? ' is-empty' : issues.length ? ' has-issues' : ' is-valid'}`} open={issues.length > 0}>
            <summary>
                <span><Check size={14} /> Model checks</span>
                <b>{!hasModel ? 'Not started' : issues.length ? `${errorCount ? `${errorCount} errors · ` : ''}${issues.length} total` : 'All clear'}</b>
            </summary>
            <div className="erd-draft-validation-body">
                {!hasModel && <p>Add a shape to begin live structural checks.</p>}
                {hasModel && !issues.length && <p>No issues found by the current structural checks. This does not validate instance data.</p>}
                {issues.map((item) => (
                    <button type="button" key={item.id} onClick={() => onFocusIssue(item)}>
                        <i className={item.level} aria-hidden="true">{item.level === 'error' ? '!' : '•'}</i>
                        <span>{item.message}</span>
                    </button>
                ))}
            </div>
        </details>
    );
}

function DraftInspector({ node, edge, nodes, onNodeChange, onShapeChange, onEdgeChange, onEdgeEndpointChange, onEdgeHandleChange, onDelete, selectionCount = 1, onAddEntity, onCreateConnected, readOnly = false, allowVisualChanges = true }) {
    if (!node && !edge) {
        return (
            <div className="erd-draft-inspector-empty">
                <span><MousePointer2 size={22} /></span>
                <h3>Select a shape</h3>
                <p>Choose a shape or connector on the canvas to {readOnly ? 'view' : 'edit'} its ERD details.</p>
                {!readOnly && <button onClick={onAddEntity}><Box size={15} /> Add an entity</button>}
            </div>
        );
    }

    if (edge) {
        const endpointNodes = {
            source: nodes.find((item) => item.id === edge.source),
            target: nodes.find((item) => item.id === edge.target),
        };
        const relationshipRoleEnds = relationshipRoleEndsForEdge(edge.source, edge.target, nodes);
        const annotation = edge.data.connectionKind === 'annotation';
        const isaConnection = !annotation && getDraftIsaConnection(endpointNodes.source, endpointNodes.target);
        const categoryConnection = !annotation && getDraftCategoryConnection(endpointNodes.source, endpointNodes.target);
        const cardinalityMode = edge.data.cardinalityMode || 'manual';
        return (
            <div className="erd-draft-property-scroll">
                <div className="erd-draft-selection-summary">
                    <span className="connector"><Route size={18} /></span>
                    <div><small>CONNECTOR</small><b>{edge.data.label || 'Plain connector'}</b></div>
                </div>
                <PropertySection title="Endpoints">
                    <div className="erd-draft-field-row">
                        <Field label="From">
                            <select value={edge.source} onChange={(event) => onEdgeEndpointChange('source', event.target.value)} disabled={readOnly}>
                                {nodes.map((item) => <option key={item.id} value={item.id}>{inspectorNodeName(item)}</option>)}
                            </select>
                        </Field>
                        <Field label="To">
                            <select value={edge.target} onChange={(event) => onEdgeEndpointChange('target', event.target.value)} disabled={readOnly}>
                                {nodes.map((item) => <option key={item.id} value={item.id}>{inspectorNodeName(item)}</option>)}
                            </select>
                        </Field>
                    </div>
                    <div className="erd-draft-field-row">
                        <Field label="From side">
                            <select value={edge.sourceHandle || 'right'} onChange={(event) => onEdgeHandleChange('sourceHandle', event.target.value)} disabled={!allowVisualChanges}>
                                <option value="top">Top</option>
                                <option value="right">Right</option>
                                <option value="bottom">Bottom</option>
                                <option value="left">Left</option>
                            </select>
                        </Field>
                        <Field label="To side">
                            <select value={edge.targetHandle || 'left'} onChange={(event) => onEdgeHandleChange('targetHandle', event.target.value)} disabled={!allowVisualChanges}>
                                <option value="top">Top</option>
                                <option value="right">Right</option>
                                <option value="bottom">Bottom</option>
                                <option value="left">Left</option>
                            </select>
                        </Field>
                    </div>
                    {allowVisualChanges && <div className="erd-draft-route-tip"><MousePointer2 size={14} /><span>Drag either blue connector head around its shape, or choose an exact side here.</span></div>}
                </PropertySection>
                {isaConnection && (
                    <PropertySection title="Inheritance">
                        <Field label="Entity role in ISA">
                            <select value={edge.data.isaRole || 'unspecified'} onChange={(event) => onEdgeChange('isaRole', event.target.value)} disabled={readOnly}>
                                <option value="unspecified">Choose a role…</option>
                                <option value="supertype">Supertype (parent)</option>
                                <option value="subtype">Subtype (child)</option>
                            </select>
                        </Field>
                        <p className="erd-draft-route-tip">This role belongs to {isaConnection.entity.data.label.trim() || 'the connected entity'}. Moving shapes or connector heads does not change it.</p>
                    </PropertySection>
                )}
                {categoryConnection && (
                    <PropertySection title="Union membership">
                        <Field label="Entity role in category">
                            <select value={edge.data.categoryRole || 'unspecified'} onChange={event => onEdgeChange('categoryRole', event.target.value)} disabled={readOnly}>
                                <option value="unspecified">Choose a role…</option>
                                <option value="member">Union member</option>
                                <option value="result">Resulting subtype</option>
                            </select>
                        </Field>
                        <p className="erd-draft-route-tip">This role belongs to {categoryConnection.entity.data.label.trim() || 'the connected entity'}. Choose at least two members and one distinct result.</p>
                    </PropertySection>
                )}
                <PropertySection title="Connector">
                    <Field label="Connector meaning">
                        <select value={edge.data.connectionKind || 'semantic'} onChange={event => onEdgeChange({ connectionKind: event.target.value, isaRole: 'unspecified', categoryRole: 'unspecified' })} disabled={readOnly}>
                            <option value="semantic">Model relationship</option>
                            <option value="annotation">Annotation only</option>
                        </select>
                    </Field>
                    {annotation && <p className="erd-draft-route-tip">Annotation lines do not satisfy model relationships, inheritance, or cardinality checks.</p>}
                    <Field label="Connector label"><input value={edge.data.label || ''} onChange={(event) => onEdgeChange('label', event.target.value)} placeholder="Optional label" readOnly={readOnly} /></Field>
                    {!annotation && relationshipRoleEnds.length > 0 && (
                        <Field label="Structured cardinality">
                            <select value={cardinalityMode} onChange={(event) => onEdgeChange({
                                cardinalityMode: event.target.value,
                                sourceCardinalityEnabled: relationshipRoleEnds.includes('source'),
                                targetCardinalityEnabled: relationshipRoleEnds.includes('target'),
                            })} disabled={readOnly}>
                                <option value="manual">Manual endpoint labels</option>
                                <option value="classic">Chen 1 / N</option>
                                <option value="minmax">Min–max (min, max)</option>
                            </select>
                        </Field>
                    )}
                    {(annotation || cardinalityMode === 'manual' || relationshipRoleEnds.length === 0) ? (
                        <div className="erd-draft-field-row">
                            <Field label="From label"><input value={edge.data.sourceLabel || ''} onChange={(event) => onEdgeChange('sourceLabel', event.target.value)} placeholder="1, N, *…" readOnly={readOnly} /></Field>
                            <Field label="To label"><input value={edge.data.targetLabel || ''} onChange={(event) => onEdgeChange('targetLabel', event.target.value)} placeholder="1, N, *…" readOnly={readOnly} /></Field>
                        </div>
                    ) : relationshipRoleEnds.map((end) => (
                        <DraftCardinalityFields
                            key={`${edge.id}:${end}:${cardinalityMode}`}
                            end={end}
                            endpoint={endpointNodes[end]}
                            data={edge.data}
                            mode={cardinalityMode}
                            onChange={onEdgeChange}
                            readOnly={readOnly}
                        />
                    ))}
                    <Field label="Line style">
                        <select value={edge.data.lineStyle || 'solid'} onChange={(event) => onEdgeChange('lineStyle', event.target.value)} disabled={readOnly}>
                            <option value="solid">Solid</option>
                            <option value="dashed">Dashed</option>
                            <option value="dotted">Dotted</option>
                        </select>
                    </Field>
                    <Field label={(isaConnection || categoryConnection || annotation) ? "Line appearance" : "Participation"}>
                        <select value={edge.data.lineCount || 'single'} onChange={(event) => onEdgeChange('lineCount', event.target.value)} disabled={readOnly}>
                            <option value="single">{(isaConnection || categoryConnection || annotation) ? 'Single line' : 'Single line · partial'}</option>
                            <option value="double">{(isaConnection || categoryConnection || annotation) ? 'Double line' : 'Double line · total'}</option>
                        </select>
                    </Field>
                    {allowVisualChanges && <div className="erd-draft-route-tip"><MousePointer2 size={14} /><span>Drag anywhere on the connector to bend it. Use the blue handle for precise adjustment.</span></div>}
                    {allowVisualChanges && Boolean(edge.data.waypoints?.length) && (
                        <button className="erd-draft-secondary-action" onClick={() => onEdgeChange('waypoints', [])}>
                            <WandSparkles size={14} /> Reset to straight
                        </button>
                    )}
                    {allowVisualChanges && <button className="erd-draft-secondary-action" onClick={() => {
                        onEdgeChange({ sourceLabelPosition: null, targetLabelPosition: null });
                    }}><MousePointer2 size={14} /> Reset label positions</button>}
                </PropertySection>
                {!readOnly && <DeleteButton label={selectionCount > 1 ? `Delete ${selectionCount} selected items` : 'Delete connector'} onClick={onDelete} />}
            </div>
        );
    }

    const Icon = shapeIcons[node.data.shape] || Box;
    const shape = node.data.shape;
    const textColor = shape === 'note' && node.data.noteTextColorMode !== 'custom'
        ? 'theme'
        : node.data.labelTextColor === 'black' ? 'black' : 'white';
    const changeTextColor = (value) => {
        if (shape === 'note') {
            onNodeChange({ noteTextColorMode: value === 'theme' ? 'theme' : 'custom', labelTextColor: value === 'black' ? 'black' : 'white' });
        } else {
            onNodeChange('labelTextColor', value);
        }
    };
    const sizeScale = Number(node.data.sizeScale) || 1;
    const textScale = Number(node.data.textScale) || 1;
    const resizeNode = (direction) => {
        const next = Math.min(1.8, Math.max(0.6, Math.round((sizeScale + direction * 0.1) * 10) / 10));
        onNodeChange('sizeScale', next);
    };
    const resizeText = (direction) => {
        const next = Math.min(1.8, Math.max(0.6, Math.round((textScale + direction * 0.1) * 10) / 10));
        onNodeChange('textScale', next);
    };
    return (
        <div className="erd-draft-property-scroll">
            <div className="erd-draft-selection-summary">
                <span style={{ background: node.data.color }}><Icon size={18} /></span>
                <div><small>{node.data.shape.replace(/([A-Z])/g, ' $1').toUpperCase()}</small><b>{inspectorNodeName(node)}</b></div>
            </div>
            {!readOnly && <DraftConnectedTools key={node.id} node={node} nodes={nodes} onCreate={onCreateConnected} />}
            <PropertySection title="Shape">
                <Field label="Name"><textarea rows="2" value={node.data.label || ''} onChange={(event) => onNodeChange('label', event.target.value)} readOnly={readOnly} /></Field>
                <Field label="Notation">
                    <select value={node.data.shape} onChange={(event) => onShapeChange(event.target.value)} disabled={readOnly}>
                        {shapeCatalog.map((shape) => <option key={shape.type} value={shape.type}>{shape.label}</option>)}
                    </select>
                </Field>
                <Field label="Notes"><textarea rows="4" value={node.data.description || ''} onChange={(event) => onNodeChange('description', event.target.value)} placeholder="Optional design notes…" readOnly={readOnly} /></Field>
            </PropertySection>
            {isDraftAttributeShape(shape) && (
                <PropertySection title="Attribute semantics">
                    <Field label="Value set / domain">
                        <input value={node.data.domain || ''} onChange={(event) => onNodeChange('domain', event.target.value)} placeholder="e.g. positive integer, ISO date" readOnly={readOnly} />
                    </Field>
                    {shape === 'derivedAttribute' && (
                        <Field label="Derivation rule">
                            <textarea rows="2" value={node.data.derivation || ''} onChange={(event) => onNodeChange('derivation', event.target.value)} placeholder="How this value is calculated" readOnly={readOnly} />
                        </Field>
                    )}
                    {shape === 'partialKeyAttribute' && (
                        <div className="erd-draft-route-tip"><KeyRound size={14} /><span>Connect this discriminator to a weak entity. It is unique only within the owner entity.</span></div>
                    )}
                </PropertySection>
            )}
            {shape === 'isa' && (
                <PropertySection title="Specialization">
                    <Field label="Show label">
                        <input type="checkbox" checked={node.data.showLabel !== false} onChange={(event) => onNodeChange('showLabel', event.target.checked)} disabled={readOnly} />
                    </Field>
                    <Field label="Specialization constraint">
                        <select value={node.data.specializationConstraint || 'disjoint'} onChange={(event) => onNodeChange('specializationConstraint', event.target.value)} disabled={readOnly}>
                            <option value="disjoint">Disjoint · at most one subtype</option>
                            <option value="overlapping">Overlapping · may belong to multiple subtypes</option>
                        </select>
                    </Field>
                    <Field label="Specialization coverage">
                        <select value={node.data.specializationCompleteness || 'partial'} onChange={(event) => onNodeChange('specializationCompleteness', event.target.value)} disabled={readOnly}>
                            <option value="partial">Partial · may belong to no subtype</option>
                            <option value="total">Total · every instance belongs to a subtype</option>
                        </select>
                    </Field>
                    <div className="erd-draft-route-tip"><ArrowDownRight size={14} /><span>The triangle marks an ISA branch. Its badge shows d (disjoint) or o (overlapping), plus partial or total coverage. Select each connector to assign its entity as the supertype or a subtype. Label text and line appearance do not change these constraints.</span></div>
                </PropertySection>
            )}
            {shape === 'category' && (
                <PropertySection title="Union category">
                    <Field label="Category coverage">
                        <select value={node.data.categoryCompleteness || 'partial'} onChange={(event) => onNodeChange('categoryCompleteness', event.target.value)} disabled={readOnly}>
                            <option value="partial">Partial union</option>
                            <option value="total">Total union</option>
                        </select>
                    </Field>
                    <div className="erd-draft-route-tip"><Circle size={14} /><span>Connect at least two source entities and one distinct resulting subtype. Select each connector to assign Union member or Resulting subtype; layout and labels do not assign these roles.</span></div>
                </PropertySection>
            )}
            {shape === 'aggregation' && (
                <PropertySection title="Aggregation semantics">
                    <div className="erd-draft-route-tip"><Layers size={14} /><span>Connect this boundary to the relationship being treated as a higher-level participant, then use the aggregation in another relationship.</span></div>
                </PropertySection>
            )}
            {shape === 'note' && (
                <PropertySection title="Text note">
                    <Field label="Text alignment">
                        <select value={node.data.textAlign || 'left'} onChange={(event) => onNodeChange('textAlign', event.target.value)} disabled={readOnly}>
                            <option value="left">Left</option>
                            <option value="center">Center</option>
                            <option value="right">Right</option>
                        </select>
                    </Field>
                </PropertySection>
            )}
            <PropertySection title="Color">
                <div className="erd-draft-color-options">
                    {colorOptions.map((color) => (
                        <button
                            key={color}
                            type="button"
                            aria-label={`Use color ${color}`}
                            aria-pressed={node.data.color === color}
                            className={node.data.color === color ? 'active' : ''}
                            style={{ background: color }}
                            onClick={() => onNodeChange('color', color)}
                            disabled={readOnly}
                        />
                    ))}
                </div>
                <Field label="Text color">
                    <select value={textColor} onChange={event => changeTextColor(event.target.value)} disabled={readOnly}>
                        {shape === 'note' && <option value="theme">Theme (automatic)</option>}
                        <option value="white">White</option>
                        <option value="black">Black</option>
                    </select>
                </Field>
            </PropertySection>
            <PropertySection title="Size">
                <div className="erd-draft-resize-row">
                    <span>Item</span>
                    <div className="erd-draft-size-control">
                        <button aria-label="Decrease item size" title="Decrease item size" disabled={!allowVisualChanges || sizeScale <= 0.6} onClick={() => resizeNode(-1)}>−</button>
                        <span>{Math.round(sizeScale * 100)}%</span>
                        <button aria-label="Increase item size" title="Increase item size" disabled={!allowVisualChanges || sizeScale >= 1.8} onClick={() => resizeNode(1)}>+</button>
                    </div>
                </div>
                <div className="erd-draft-resize-row">
                    <span>Text</span>
                    <div className="erd-draft-size-control">
                        <button aria-label="Decrease text size" title="Decrease text size" disabled={!allowVisualChanges || textScale <= 0.6} onClick={() => resizeText(-1)}>−</button>
                        <span>{Math.round(textScale * 100)}%</span>
                        <button aria-label="Increase text size" title="Increase text size" disabled={!allowVisualChanges || textScale >= 1.8} onClick={() => resizeText(1)}>+</button>
                    </div>
                </div>
                {allowVisualChanges && (sizeScale !== 1 || textScale !== 1) && (
                    <button className="erd-draft-size-reset" onClick={() => {
                        onNodeChange({ sizeScale: 1, textScale: 1 });
                    }}>Reset both to 100%</button>
                )}
            </PropertySection>
            {!readOnly && <DeleteButton label={selectionCount > 1 ? `Delete ${selectionCount} selected items` : 'Delete shape'} onClick={onDelete} />}
        </div>
    );
}

function PropertySection({ title, children }) {
    return <section className="erd-draft-property-section"><h3>{title}</h3>{children}</section>;
}

function Field({ label, children }) {
    return <label className="erd-draft-field"><span>{label}</span>{children}</label>;
}

function DeleteButton({ label, onClick }) {
    return <button className="erd-draft-delete-button" onClick={onClick}><Trash2 size={15} /> {label}</button>;
}
