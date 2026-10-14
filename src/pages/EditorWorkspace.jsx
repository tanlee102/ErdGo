import { useContext, useRef } from 'react';
import { Outlet } from 'react-router-dom';
import RootLayoutProvider, { RootLayoutContext } from '@/contexts/RootLayoutContext';
import { ConfirmProvider } from '@/components/ConfirmDialog';
import { NavigationGuardProvider } from '@/components/NavigationGuard';
import { NotificationProvider } from '@/components/Notifications';
import { AddTable } from '@/components/AddTable';
import LocalFileDialog from '@/features/files/components/LocalFileDialog';
import Modal from '@/components/Modal';

function EditorOverlays() {
    const { displayModalAddTable, setDisplayModalAddTable } = useContext(RootLayoutContext);
    const closeAddTableRef = useRef(null);

    return (
        <>
            {displayModalAddTable && (
                <Modal className="table-form-modal" title="Add Table" displayModal={displayModalAddTable} setDisplayModal={setDisplayModalAddTable} onRequestClose={() => closeAddTableRef.current?.()} body={<AddTable closeRequestRef={closeAddTableRef} />} />
            )}
            <LocalFileDialog />
        </>
    );
}

export default function EditorWorkspace() {
    return (
        <NotificationProvider>
            <ConfirmProvider>
                <NavigationGuardProvider>
                    <RootLayoutProvider>
                        <Outlet />
                        <EditorOverlays />
                    </RootLayoutProvider>
                </NavigationGuardProvider>
            </ConfirmProvider>
        </NotificationProvider>
    );
}
