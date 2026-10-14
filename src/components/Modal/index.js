/** Shared modal with focus containment and feature-owned close confirmation. */
import React from 'react';
import { useId, useRef } from 'react';
import useModalFocus from './useModalFocus';

import './index.css';

const Modal = ({ displayModal, setDisplayModal, title, body, footer, displayfooter, className = '', onRequestClose }) => {
    const dialogRef = useRef(null);
    const titleId = useId();
    const requestClose = () => onRequestClose ? onRequestClose() : setDisplayModal(false);
    useModalFocus(dialogRef, displayModal, requestClose);

    return (
        <div
            className={`modal ${className}`.trim()}
            style={{ display: displayModal ? 'block' : 'none' }}
            onClick={(event) => {
                if (event.target === event.currentTarget) requestClose();
            }}
        >
            <div ref={dialogRef} className="modal-content" role={displayModal ? 'dialog' : undefined} aria-modal={displayModal ? true : undefined} aria-labelledby={titleId} tabIndex={-1}>
                <div className="modal-header">
                    <div id={titleId}>{title}</div>
                    <button type="button" className="close-modal" aria-label={`Close ${title}`} onClick={requestClose}>
                        &times;
                    </button>
                </div>
                <div className="modal-body">{body}</div>
                {displayfooter ? <div className="modal-footer">{footer}</div> : ''}
            </div>
        </div>
    );
};

export default Modal;
