import { useContext } from 'react';
import RootLayoutProvider, { RootLayoutContext } from '@/contexts/RootLayoutContext';
import { ConfirmProvider } from '@/components/ConfirmDialog';
import { NavigationGuardProvider } from '@/components/NavigationGuard';
import { NotificationProvider } from '@/components/Notifications';
import { AddTable } from '@/components/AddTable';
import LocalFileDialog from '@/features/files/components/LocalFileDialog';
import EditorPage from '@/pages/EditorPage';

function EditorOverlays() {
    const { displayModalAddTable, setDisplayModalAddTable } = useContext(RootLayoutContext);

    return (
        <>
            {displayModalAddTable && (
                <div className="add-table-dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setDisplayModalAddTable(false)}>
                    <section className="add-table-dialog" role="dialog" aria-modal="true" aria-label="Add table">
                        <header>
                            <h2>Add table</h2>
                            <button type="button" onClick={() => setDisplayModalAddTable(false)} aria-label="Close add table">×</button>
                        </header>
                        <AddTable />
                    </section>
                </div>
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
                        <EditorPage />
                        <EditorOverlays />
                    </RootLayoutProvider>
                </NavigationGuardProvider>
            </ConfirmProvider>
        </NotificationProvider>
    );
}
