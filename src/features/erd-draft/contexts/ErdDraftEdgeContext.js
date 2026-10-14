/** Callback contract shared between the ERD builder workspace and custom edge instances. */
import { createContext } from 'react';

const ErdDraftEdgeContext = createContext({
    readOnly: false,
    onSelectEdge: () => {},
    onWaypointChange: () => {},
    onLabelPositionChange: () => {},
    onEndpointHandleChange: () => {},
});

export default ErdDraftEdgeContext;
