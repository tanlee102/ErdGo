import { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import ApiKeyModal from './ApiKeyModal';
import { geminiCode } from './material';
import { buildAiRepairInstruction, preflightAiResult } from '@/features/editor/lib/aiPreflight';
import { useNotifications } from '@/components/Notifications';

import './index.css';

import KeyIcon from '@/icons/KeyIcon';
import SendIcon from '@/icons/SendIcon';
import BookIcon from '@/icons/BookIcon';

// Models that use the user's own API key (user pays for their own quota)
const USER_API_KEY_MODELS = [
    { value: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash' },

    { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
    { value: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite' },
    { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },

    { value: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash-Lite' },
    { value: 'gemini-3-flash-preview', label: 'Gemini 3 Flash Preview' },
    { value: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro Preview' },
];

export default function ChatInput({
    activeFileId,
    showAiSuggestions,
    setShowAiSuggestions,
    originalSqlInput,
    setOriginalSqlInput,
    currentlyProcessingAi,
    setCurrentlyProcessingAi,
    setAiSuggestedCode,
    setAiTabChanges,
    sqlInput,
    tabWorkspace,
    remainingBlocksCount,
    handleAcceptAllRemain,
    handleRejectAllRemain,
    setAcceptedBlocks,
    setRejectedBlocks,
    onAiRequestStart,
    onAiRequestFailure,
    isCollapsed,
}) {
    const { notifyError } = useNotifications();

    const [isLoading, setIsLoading] = useState(false);
    const [explanation, setExplanation] = useState('');
    const [promptError, setPromptError] = useState('');
    const [showApiKeyModal, setShowApiKeyModal] = useState(false);
    const [apiKey, setApiKey] = useState('');
    const [isApiKeyEnabled, setIsApiKeyEnabled] = useState(true);
    const [tempApiKey, setTempApiKey] = useState('');
    const [promptValue, setPromptValue] = useState('');
    const [conversationalResponse, setConversationalResponse] = useState('');
    const promptRef = useRef(null);
    const latestFileRef = useRef(activeFileId);
    const inFlightRequestRef = useRef(null);

    // A saved key can be paused without deleting it from this browser.
    const isPersonalApiKeyActive = Boolean(apiKey && isApiKeyEnabled);
    const availableModels = USER_API_KEY_MODELS;
    const promptMaxLength = Infinity;

    // State for selected model
    const [model, setModel] = useState(() => {
        return USER_API_KEY_MODELS[0].value;
    });

    const handleInput = (e) => {
        setPromptError('');
        setPromptValue(e.currentTarget.textContent || '');
    };

    // Load the saved API key and its enabled state on mount. Keys saved before
    // this setting existed stay enabled, preserving the previous behavior.
    useEffect(() => {
        try {
            const savedKey = localStorage.getItem('gemini_api_key');
            if (savedKey) {
                setApiKey(savedKey);
            }
            setIsApiKeyEnabled(localStorage.getItem('gemini_api_key_enabled') !== 'false');
        } catch {
            // localStorage not available (e.g., private browsing)
        }
    }, []);

    const handleApiKeyEnabledChange = (enabled) => {
        setIsApiKeyEnabled(enabled);
        try {
            localStorage.setItem('gemini_api_key_enabled', String(enabled));
        } catch {
            // localStorage not available (e.g., private browsing)
        }
    };

    // Handle model selection change
    const handleModelChange = (e) => {
        setModel(e.target.value);
    };

    useEffect(() => {
        latestFileRef.current = activeFileId;
        inFlightRequestRef.current = null;
        setIsLoading(false);
        setExplanation('');
        setPromptError('');
        setPromptValue('');
        setConversationalResponse('');
        setCurrentlyProcessingAi(false);

        if (promptRef.current) {
            promptRef.current.textContent = '';
        }
    }, [activeFileId, setCurrentlyProcessingAi]);

    const sendToAi = async () => {
        const prompt = promptRef.current?.textContent?.trim();
        if (!prompt) {
            setPromptError('Please enter a prompt');
            promptRef.current?.focus();
            return;
        }
        if (Number.isFinite(promptMaxLength) && prompt.length > promptMaxLength) {
            setPromptError(`Prompt must be ${promptMaxLength.toLocaleString()} characters or less`);
            promptRef.current?.focus();
            return;
        }

        if (!isPersonalApiKeyActive) {
            setPromptError('Add and enable your Gemini API key before sending a request');
            setShowApiKeyModal(true);
            return;
        }

        const requestId = `${activeFileId || 'unknown'}-${Date.now()}`;
        const requestPrompt = prompt;
        // Keep an existing review visible while its candidate is sent as the
        // base for this follow-up request. The new response replaces it only
        // after it has passed validation.
        const preservesPendingReview = showAiSuggestions;
        inFlightRequestRef.current = requestId;

        setIsLoading(true);
        setCurrentlyProcessingAi(true);
        if (!preservesPendingReview) {
            setShowAiSuggestions(false);
            setAiSuggestedCode('');
            setAiTabChanges?.(null);
            setExplanation('');
        }
        setPromptError('');
        if (!preservesPendingReview) setConversationalResponse('');
        if (originalSqlInput.trim() === '') {
            setOriginalSqlInput(sqlInput);
        }
        onAiRequestStart?.({ preservesPendingReview });

        try {
            const requestAi = async (promptToSend, repairReason = null) => {
                return geminiCode(sqlInput, promptToSend, model, apiKey, { tabWorkspace, repairReason });
            };

            let result = await requestAi(requestPrompt);
            let preflight = preflightAiResult({ result, tabWorkspace, sqlInput });

            if (!preflight.ok && !result?.isConversational && preflight.repairable !== false) {
                // One automatic repair keeps the workflow smooth while still
                // requiring the repaired response to pass the same validation.
                result = await requestAi(requestPrompt, buildAiRepairInstruction(preflight.reason));
                preflight = preflightAiResult({ result, tabWorkspace, sqlInput });
                if (!preflight.ok) {
                    throw new Error(`The AI response could not be safely repaired: ${preflight.reason}`);
                }
            }

            const { suggestedCode, explanation: aiExplanation, isConversational, tabChanges } = result;

            if (inFlightRequestRef.current !== requestId || latestFileRef.current !== activeFileId) {
                return;
            }

            if (!preflight.ok) {
                throw new Error(preflight.reason);
            }

            if (!suggestedCode) {
                throw new Error('No SQL code returned from AI');
            }

            const invalidTabChange = tabChanges?.actions?.find((action) => action.type === 'invalid');
            if (invalidTabChange) {
                throw new Error(invalidTabChange.reason);
            }

            if (isConversational) {
                // A plain answer has no reviewable change. Never put unchanged
                // SQL into the diff engine, otherwise it creates an empty review
                // and locks the editor until the user accepts or rejects it.
                setConversationalResponse(aiExplanation || '');
                onAiRequestFailure?.({ preservesPendingReview });

                if (!preservesPendingReview) {
                    setExplanation('');
                    setAcceptedBlocks(new Set());
                    setRejectedBlocks(new Set());
                    setAiSuggestedCode('');
                    setAiTabChanges?.(null);
                    setOriginalSqlInput('');
                    setShowAiSuggestions(false);
                }
            } else {
                setConversationalResponse('');
                setExplanation(aiExplanation || '');
                setAcceptedBlocks(new Set());
                setRejectedBlocks(new Set());
                setAiSuggestedCode(suggestedCode);
                setAiTabChanges?.(tabChanges || null);
                setShowAiSuggestions(true);
            }

            if (promptRef.current) {
                promptRef.current.textContent = '';
                setPromptValue('');
            }
        } catch (error) {
            if (inFlightRequestRef.current !== requestId || latestFileRef.current !== activeFileId) {
                return;
            }

            console.error('AI suggestion error:', error);
            onAiRequestFailure?.({ preservesPendingReview });
            notifyError(error.message || 'Failed to get AI suggestions. Please try again.', { title: 'AI request failed' });
        } finally {
            if (inFlightRequestRef.current === requestId && latestFileRef.current === activeFileId) {
                inFlightRequestRef.current = null;
                setCurrentlyProcessingAi(false);
                setIsLoading(false);
            }
        }
    };

    const handleKeyDown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendToAi();
        }
    };

    const handlePaste = (e) => {
        // Prevent default paste behavior
        e.preventDefault();

        // Get plain text from clipboard
        const text = e.clipboardData.getData('text/plain');

        // Get current selection
        const selection = window.getSelection();
        if (!selection.rangeCount) return;

        // Delete current selection if any
        selection.deleteFromDocument();

        // Split text by line breaks and insert with <br> elements
        const lines = text.split('\n');
        const range = selection.getRangeAt(0);
        const fragment = document.createDocumentFragment();

        lines.forEach((line, index) => {
            fragment.appendChild(document.createTextNode(line));
            if (index < lines.length - 1) {
                fragment.appendChild(document.createElement('br'));
            }
        });

        range.insertNode(fragment);

        // Move cursor to end of inserted text
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);

        // Trigger input event to update state
        if (promptRef.current) {
            setPromptError('');
            setPromptValue(promptRef.current.textContent || '');
        }
    };

    if (isCollapsed) return null;

    return (
        <div className={`ai-prompt-input ${showAiSuggestions ? 'ai-prompt-input--active' : ''}`}>
            {showAiSuggestions && remainingBlocksCount > 0 && (
                <div className="ai-prompt-input__actions">
                    <button type="button" className="ai-prompt-input__btn accept" onClick={handleAcceptAllRemain} disabled={currentlyProcessingAi || remainingBlocksCount === 0}>
                        ✓ Accept {remainingBlocksCount > 0 && `(${remainingBlocksCount})`}
                    </button>
                    <button type="button" className="ai-prompt-input__btn reject" onClick={handleRejectAllRemain} disabled={currentlyProcessingAi || remainingBlocksCount === 0}>
                        ✕ Reject {remainingBlocksCount > 0 && `(${remainingBlocksCount})`}
                    </button>
                </div>
            )}

            {showAiSuggestions && explanation && (
                <div className="ai-prompt-input__explanation">
                    <div className="ai-prompt-input__explanation-label">Explanation:</div>
                    <div className="ai-prompt-input__explanation-text">
                        <ReactMarkdown>{explanation}</ReactMarkdown>
                    </div>
                </div>
            )}

            {conversationalResponse && (
                <div className="ai-prompt-input__explanation ai-prompt-input__response">
                    <div className="ai-prompt-input__explanation-label">AI Response:</div>
                    <div className="ai-prompt-input__explanation-text">
                        <ReactMarkdown>{conversationalResponse}</ReactMarkdown>
                    </div>
                </div>
            )}

            <div
                className={`ai-prompt-input__field ${currentlyProcessingAi ? 'ai-prompt-input__field--disabled' : ''} ${!promptValue ? 'ai-prompt-input__field--empty' : ''}`}
                contentEditable={!currentlyProcessingAi}
                ref={promptRef}
                data-placeholder="Ask AI to edit SQL..."
                spellCheck={false}
                suppressContentEditableWarning={true}
                onKeyDown={handleKeyDown}
                onInput={handleInput}
                onPaste={handlePaste}
            />

            {promptError && (
                <div className="ai-prompt-input__error" role="alert">
                    {promptError}
                </div>
            )}

            <div className="ai-prompt-input__bottom">
                <button
                    type="button"
                    className={`ai-prompt-input__api-key-btn ${isPersonalApiKeyActive ? 'ai-prompt-input__api-key-btn--active' : ''}`}
                    onClick={() => {
                        setShowApiKeyModal(true);
                        setTempApiKey(apiKey);
                    }}
                    title={isPersonalApiKeyActive ? 'Gemini API key enabled' : apiKey ? 'Gemini API key disabled' : 'Set Gemini API key'}
                >
                    <KeyIcon width="20" height="20" />
                </button>
                <a href="https://github.com/tanlee102/ErdGo#supported-sql" target="_blank" rel="noopener noreferrer" className="ai-prompt-input__sql-guide-btn" title="SQL Guide">
                    <BookIcon width="14" height="14" />
                    <span>SQL Guide</span>
                </a>
                <div className="ai-prompt-input__model-container">
                    <select className="ai-prompt-input__model" value={model} onChange={handleModelChange} disabled={isLoading}>
                        {availableModels.map((m) => (
                            <option key={m.value} value={m.value}>
                                {m.label}
                            </option>
                        ))}
                    </select>
                </div>
                <button type="button" className="ai-prompt-input__btn send" onClick={sendToAi} disabled={isLoading}>
                    {isLoading ? (
                        <span className="ai-prompt-input__spinner"></span>
                    ) : (
                        <span className="ai-prompt-input__send-icon">
                            <SendIcon width="20" height="20" />
                        </span>
                    )}
                </button>
            </div>

            <ApiKeyModal
                showApiKeyModal={showApiKeyModal}
                setShowApiKeyModal={setShowApiKeyModal}
                apiKey={apiKey}
                setApiKey={setApiKey}
                isApiKeyEnabled={isApiKeyEnabled}
                setIsApiKeyEnabled={handleApiKeyEnabledChange}
                tempApiKey={tempApiKey}
                setTempApiKey={setTempApiKey}
            />
        </div>
    );
}
