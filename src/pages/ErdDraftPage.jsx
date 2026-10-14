import { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { ReactFlowProvider } from '@xyflow/react';
import ErdDraftWorkspace from '@/features/erd-draft/components/ErdDraftWorkspace';

export default function ErdDraftPage() {
    const { index } = useParams();
    useEffect(() => { document.title = 'ERD Builder — ERD Go'; }, []);
    return <ReactFlowProvider><ErdDraftWorkspace index={index} /></ReactFlowProvider>;
}
