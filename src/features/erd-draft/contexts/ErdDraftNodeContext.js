/** Callback contract shared between the ERD builder workspace and custom node instances. */
import { createContext } from 'react';

const ErdDraftNodeContext = createContext({
    readOnly: true,
    showAttributeCounts: false,
    onLabelChange: () => {},
});

export default ErdDraftNodeContext;
