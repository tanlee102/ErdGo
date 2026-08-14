/** Shared chooser for starting a new SQL, Prisma, or free-form ERD document. */
import React from 'react';
import { createPortal } from 'react-dom';

import './index.css';

import BlankFileIcon from '@/icons/BlankFileIcon';
import OptionIcon from '@/icons/OptionIcon';
import ImportSqlIcon from '@/icons/ImportSqlIcon';

const CreateNewFileDialog = ({
    isDisplay,
    onSelectSample,
    onSelectBlank,
    onSelectImport,
    title = 'Create New File',
    subtitle = 'Choose how you want to start',
    sampleTitle = 'Create with Sample',
    sampleDescription = 'Explore a schema and sample data in separate tabs',
    blankTitle = 'Create Blank File',
    blankDescription = 'Start with a Schema tab and helpful SQL hints',
    importTitle = 'Import SQL Files',
    importDescription = 'Drop SQL or plain-text database dumps into separate tabs',
}) => {
    if (!isDisplay) return null;

    const dialog = (
        <div className="create-new-file-overlay">
            <div className="create-new-file-dialog" role="dialog" aria-modal="true" aria-labelledby="create-new-file-title">
                <div className="create-new-file-header">
                    <h2 id="create-new-file-title">{title}</h2>
                    <p className="create-new-file-subtitle">{subtitle}</p>
                </div>

                <div className="create-new-file-options">
                    <button className="create-option-card sample-card" onClick={onSelectSample}>
                        <div className="option-icon">
                            <OptionIcon width="48" height="48" />
                        </div>
                        <div className="option-content">
                            <h3>{sampleTitle}</h3>
                            <p>{sampleDescription}</p>
                        </div>
                    </button>

                    <button className="create-option-card blank-card" onClick={onSelectBlank}>
                        <div className="option-icon">
                            <BlankFileIcon width="48" height="48" />
                        </div>
                        <div className="option-content">
                            <h3>{blankTitle}</h3>
                            <p>{blankDescription}</p>
                        </div>
                    </button>

                    {onSelectImport && (
                        <button className="create-option-card import-card" onClick={onSelectImport} aria-label={importTitle}>
                            <div className="option-icon">
                                <ImportSqlIcon width="42" height="42" />
                            </div>
                            <div className="option-content">
                                <h3>{importTitle}</h3>
                                <p>{importDescription}</p>
                            </div>
                        </button>
                    )}
                </div>
            </div>
        </div>
    );

    // Tool workspaces have intentionally broad, locally-scoped button styles.
    // Render this shared modal outside those workspaces so its cards look and
    // behave identically from SQL, Prisma, and ERD Builder routes.
    return typeof document === 'undefined' ? dialog : createPortal(dialog, document.body);
};

export default CreateNewFileDialog;
