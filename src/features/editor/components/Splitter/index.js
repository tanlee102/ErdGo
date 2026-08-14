import React from 'react';
import ChevronLeftIcon from '@/icons/ChevronLeftIcon';
import ChevronRightIcon from '@/icons/ChevronRightIcon';

import './index.css';

const Splitter = ({ onMouseDown, toggleButtonText, toggleButtonTitle, onToggleClick, splitterRef }) => {
    // Render appropriate icon based on state
    const renderIcon = () => {
        if (toggleButtonText === '>') {
            return <ChevronRightIcon width="12" height="12" />;
        } else {
            return <ChevronLeftIcon width="12" height="12" />;
        }
    };

    return (
        <div className="panel-splitter" ref={splitterRef} onMouseDown={onMouseDown}>
            {/* Collapse/Expand Toggle Button */}
            <button className="splitter-toggle-btn" onClick={onToggleClick} title={toggleButtonTitle}>
                {renderIcon()}
            </button>
        </div>
    );
};

export default Splitter;
