// @vitest-environment jsdom
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { NotificationProvider, useNotifications } from '@/components/Notifications';

it('invokes and dismisses an optional success action through a keyboard-accessible button', () => {
    const undo = vi.fn();
    function Harness() {
        const { notifySuccess } = useNotifications();
        return <button onClick={() => notifySuccess('Updated', { action: { label: 'Undo', onClick: undo } })}>Change</button>;
    }
    render(<NotificationProvider><Harness /></NotificationProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(undo).toHaveBeenCalledOnce();
    expect(screen.queryByText('Updated')).not.toBeInTheDocument();
});
