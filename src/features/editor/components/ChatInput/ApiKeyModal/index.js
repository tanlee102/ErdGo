import { useRef, useEffect } from 'react';

import './index.css';

export default function ApiKeyModal({ showApiKeyModal, setShowApiKeyModal, apiKey, setApiKey, isApiKeyEnabled, setIsApiKeyEnabled, tempApiKey, setTempApiKey }) {
    const modalRef = useRef(null);

    // Close modal when clicking outside
    useEffect(() => {
        const handleClickOutside = (event) => {
            if (modalRef.current && !modalRef.current.contains(event.target)) {
                setShowApiKeyModal(false);
                setTempApiKey('');
            }
        };

        if (showApiKeyModal) {
            document.addEventListener('mousedown', handleClickOutside);
        }

        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
        };
    }, [showApiKeyModal, setShowApiKeyModal, setTempApiKey]);

    const handleSaveApiKey = () => {
        if (tempApiKey.trim()) {
            try {
                localStorage.setItem('gemini_api_key', tempApiKey.trim());
            } catch {
                // localStorage not available
            }
            setApiKey(tempApiKey.trim());
            setShowApiKeyModal(false);
            setTempApiKey('');
        }
    };

    const handleRemoveApiKey = () => {
        try {
            localStorage.removeItem('gemini_api_key');
        } catch {
            // localStorage not available
        }
        setApiKey('');
        setIsApiKeyEnabled(true);
        setShowApiKeyModal(false);
        setTempApiKey('');
    };

    const handleModalKeyDown = (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            handleSaveApiKey();
        } else if (e.key === 'Escape') {
            setShowApiKeyModal(false);
            setTempApiKey('');
        }
    };

    if (!showApiKeyModal) return null;

    return (
        <div className="api-key-input__modal-overlay">
            <div className="api-key-input__modal" ref={modalRef}>
                <div className="api-key-input__modal-header">
                    <h3>Gemini API Key</h3>
                    <button
                        type="button"
                        className="api-key-input__modal-close"
                        onClick={() => {
                            setShowApiKeyModal(false);
                            setTempApiKey('');
                        }}
                    >
                        ×
                    </button>
                </div>
                <div className="api-key-input__modal-body">
                    <input type="password" className="api-key-input__modal-input" placeholder="Enter your Gemini API key" value={tempApiKey} onChange={(e) => setTempApiKey(e.target.value)} onKeyDown={handleModalKeyDown} autoFocus autoComplete="off" />
                    <label className={`api-key-input__toggle ${apiKey ? '' : 'api-key-input__toggle--disabled'}`}>
                        <input type="checkbox" checked={isApiKeyEnabled} onChange={(e) => setIsApiKeyEnabled(e.target.checked)} disabled={!apiKey} />
                        <span className="api-key-input__toggle-track" aria-hidden="true" />
                        <span>
                            <strong>Use this key for AI requests</strong>
                            <small>{isApiKeyEnabled ? 'Gemini requests use your key.' : 'Gemini requests are paused.'}</small>
                        </span>
                    </label>
                    <p className="api-key-input__modal-hint">
                        Get your API key from{' '}
                        <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener noreferrer">
                            Google AI Studio
                        </a>
                    </p>
                </div>
                <div className="api-key-input__modal-footer">
                    {apiKey && (
                        <button type="button" className="api-key-input__modal-btn remove" onClick={handleRemoveApiKey}>
                            Remove Key
                        </button>
                    )}
                    <button
                        type="button"
                        className="api-key-input__modal-btn cancel"
                        onClick={() => {
                            setShowApiKeyModal(false);
                            setTempApiKey('');
                        }}
                    >
                        Cancel
                    </button>
                    <button type="button" className="api-key-input__modal-btn save" onClick={handleSaveApiKey} disabled={!tempApiKey.trim()}>
                        Save
                    </button>
                </div>
            </div>
        </div>
    );
}
