/** ERD-side controls for schema actions, viewport operations, colors, and inferred relationships. */
import { useContext, useRef } from 'react';
import { RootLayoutContext } from '@/contexts/RootLayoutContext';

import FitScreenIcon from '@/icons/FitScreenIcon';
import ColorPickerIcon from '@/icons/ColorPickerIcon';
import TrashIcon from '@/icons/TrashIcon';
import FullConnectIcon from '@/icons/FullConnectIcon';
import AddSquareIcon from '@/icons/AddSquareIcon';
import ListIcon from '@/icons/ListIcon';
import AutoColorOnlyIcon from '@/icons/AutoColorOnlyIcon';
import RelationshipSuggestionsPanel from './RelationshipSuggestionsPanel';

export default function ErdControls({ erdRendering, showTableOwnerLabels = false, onShowTableOwnerLabelsChange }) {
    const { setDisplayModalAddTable } = useContext(RootLayoutContext);
    const erdHealthButtonRef = useRef(null);
    const relationshipInference = erdRendering?.relationshipInference;
    const schemaQuality = relationshipInference?.schemaQuality;
    const hasSchemaScore = Number.isInteger(schemaQuality?.score) && schemaQuality.score > 0;
    const pendingSuggestionCount = relationshipInference?.pendingCount || 0;
    const suggestionLabel = pendingSuggestionCount > 0 ? `, ${pendingSuggestionCount} relationship ${pendingSuggestionCount === 1 ? 'suggestion' : 'suggestions'}` : '';
    const erdHealthLabel = hasSchemaScore ? `Open ERD health, score ${schemaQuality.score} out of 100, ${schemaQuality.label}${suggestionLabel}` : 'ERD health is not available until the schema has a table';

    return (
        <div id="erd-controls">
            <button className="erd-btn" id="zoom-in" title="Zoom In">
                +
            </button>
            <button className="erd-btn" id="zoom-out" title="Zoom Out">
                −
            </button>

            <button className="erd-btn" id="fit-btn" title="Fit to Screen">
                <FitScreenIcon />
            </button>

            <button
                className={`erd-btn erd-btn--toggle ${erdRendering.fullConnect === true ? 'active' : ''}`}
                id="full-connect-btn"
                type="button"
                aria-pressed={erdRendering.fullConnect === true}
                onClick={() => erdRendering.setFullConnect(erdRendering.fullConnect !== true)}
                title="Toggle Full Connect"
            >
                <FullConnectIcon />
            </button>

            <div className="erd-control-popover">
                <button className="erd-btn" id="layout-mode-btn" type="button" title="Layout Mode: Left to Right" aria-haspopup="dialog" aria-controls="layout-popup" aria-expanded="false">
                    <span id="layout-mode-label">LR</span>
                </button>
                <div id="layout-popup" role="dialog" aria-label="Layout mode">
                    <div className="layout-popup-header">
                        <svg className="layout-popup-header-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <rect x="3" y="3" width="7" height="7" rx="1" />
                            <rect x="14" y="3" width="7" height="7" rx="1" />
                            <rect x="3" y="14" width="7" height="7" rx="1" />
                            <rect x="14" y="14" width="7" height="7" rx="1" />
                        </svg>
                        <div className="layout-popup-title">Layout Mode</div>
                    </div>
                    <div id="layout-option-list" className="layout-option-list"></div>
                </div>
            </div>

            {typeof onShowTableOwnerLabelsChange === 'function' && (
                <button
                    className={`erd-btn erd-btn--toggle ${showTableOwnerLabels === true ? 'active' : ''}`}
                    id="table-owner-labels-btn"
                    type="button"
                    title={showTableOwnerLabels === true ? 'Hide tab names on tables' : 'Show tab names on tables'}
                    aria-label={showTableOwnerLabels === true ? 'Hide tab names on tables' : 'Show tab names on tables'}
                    aria-pressed={showTableOwnerLabels === true}
                    onClick={() => onShowTableOwnerLabelsChange(showTableOwnerLabels !== true)}
                >
                    <svg viewBox="28 61 94 94" fill="currentColor" aria-hidden="true">
                        <path
                            fillRule="evenodd"
                            clipRule="evenodd"
                            d="M92.12 99.87V111.94L84.69 112.36V85.07C84.69 73.15 92.45 67.73 99.78 67.73C107.43 67.73 115.09 73.53 115.09 83.59C115.09 99.33 98.61 99.87 92.12 99.87ZM99.69 75.43C96.05 75.43 92.16 77.96 92.16 85.05V92.28C107.31 92.28 107.31 86.85 107.31 83.6C107.31 78 103.36 75.43 99.69 75.43ZM58.24 99.88C51.66 99.88 34.91 99.88 34.91 83.88C34.91 73.65 42.69 67.76 50.46 67.76C57.91 67.76 65.8 73.27 65.8 85.38V92.38L80.51 92.49L79.82 99.94L58.24 99.88ZM58.24 85.35C58.24 78.02 54.24 75.41 50.46 75.41C46.68 75.41 42.59 78.05 42.59 83.85C42.59 87.21 42.59 92.28 58.24 92.32V85.35ZM58.24 116.29V104.9L65.8 103.9V130.9C65.8 143 57.91 148.52 50.46 148.52C42.69 148.52 34.91 142.62 34.91 132.4C34.91 116.34 51.66 116.29 58.24 116.29ZM50.46 140.77C54.23 140.77 58.24 138.16 58.24 130.83V123.83C42.59 123.88 42.59 128.95 42.59 132.31C42.59 138.13 46.67 140.77 50.46 140.77ZM113.6 131.77C113.6 141.32 106.34 146.77 99.08 146.77C92.08 146.77 84.76 141.63 84.76 130.32V123.8H70.45L69.96 116.2H91.82C98 116.29 113.6 116.88 113.6 131.8V131.77ZM92.13 130.43C92.13 136.98 95.72 139.32 99.13 139.32C102.54 139.32 106.13 136.96 106.13 131.77C106.13 128.77 106.13 124.24 92.13 124.2V130.43Z"
                        />
                    </svg>
                </button>
            )}

            <div className="erd-control-popover">
                <button className="erd-btn" id="table-nav-btn" type="button" title="Table Navigator" aria-haspopup="dialog" aria-controls="table-nav-popup" aria-expanded="false">
                    <ListIcon width="17px" height="17px" />
                </button>
                <div id="table-nav-popup" role="dialog" aria-label="Table navigator">
                    <div className="table-nav-header">
                        <svg className="table-nav-header-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                            <line x1="3" y1="9" x2="21" y2="9" />
                            <line x1="3" y1="15" x2="21" y2="15" />
                            <line x1="9" y1="3" x2="9" y2="21" />
                        </svg>
                        <div className="table-nav-title">Tables</div>
                        <div id="table-nav-count" className="table-nav-count"></div>
                    </div>
                    <div className="table-nav-search-wrap">
                        <svg className="table-nav-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="11" cy="11" r="8" />
                            <line x1="21" y1="21" x2="16.65" y2="16.65" />
                        </svg>
                        <input id="table-nav-search" type="text" placeholder="Search table..." spellCheck="false" autoComplete="off" />
                    </div>
                    <div id="table-nav-list" className="table-nav-list"></div>
                </div>
            </div>

            <div className="erd-control-popover">
                <button className="erd-btn" id="auto-color-only-btn" type="button" title="Table Colors" aria-label="Table Colors" aria-haspopup="dialog" aria-controls="auto-color-popup" aria-expanded="false">
                    <AutoColorOnlyIcon width="24px" height="24px" />
                </button>

                <div id="auto-color-popup" role="dialog" aria-label="Table colors">
                    <div className="auto-color-header">
                        <svg className="auto-color-header-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <rect x="3" y="3" width="7" height="7" rx="1" />
                            <rect x="14" y="3" width="7" height="7" rx="1" />
                            <rect x="3" y="14" width="7" height="7" rx="1" />
                            <rect x="14" y="14" width="7" height="7" rx="1" />
                        </svg>
                        <div className="auto-color-title">Table Colors</div>
                    </div>
                    <div className="auto-color-list">
                        <button className="auto-color-option" type="button" data-auto-color-action="bright">
                            <div className="auto-color-palette-preview auto-color-palette-preview--bright" aria-hidden="true">
                                <i /><i /><i /><i />
                            </div>
                            <span className="auto-color-option-copy">
                                <span className="auto-color-option-label">Bright <em className="auto-color-recommendation auto-color-recommendation--dark">Recommended</em></span>
                                <small>Fresh, cheerful colors</small>
                            </span>
                        </button>
                        <button className="auto-color-option" type="button" data-auto-color-action="balanced">
                            <div className="auto-color-palette-preview auto-color-palette-preview--balanced" aria-hidden="true">
                                <i /><i /><i /><i />
                            </div>
                            <span className="auto-color-option-copy">
                                <span className="auto-color-option-label">Balanced <em className="auto-color-recommendation auto-color-recommendation--light">Recommended</em></span>
                                <small>Vivid with stronger contrast</small>
                            </span>
                        </button>
                        <button className="auto-color-option" type="button" data-auto-color-action="deep">
                            <div className="auto-color-palette-preview auto-color-palette-preview--deep" aria-hidden="true">
                                <i /><i /><i /><i />
                            </div>
                            <span className="auto-color-option-copy">
                                <span className="auto-color-option-label">Deep</span>
                                <small>Rich colors for dark canvases</small>
                            </span>
                        </button>
                        <div className="auto-color-divider" role="separator" />
                        <button className="auto-color-option auto-color-option--clear" type="button" data-auto-color-action="clear">
                            <div className="auto-color-option-icon">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M20 20H7L3 16l9.5-9.5" />
                                    <path d="m18 13-1.5-1.5" />
                                    <path d="M22 2 12.5 11.5" />
                                </svg>
                            </div>
                            <span className="auto-color-option-label">Clear all colors</span>
                        </button>
                    </div>
                </div>
            </div>

            <button className="erd-btn" id="add-table-btn" title="Add Table" onClick={() => setDisplayModalAddTable(true)}>
                <AddSquareIcon />
            </button>

            <button className="erd-btn" id="clear-priority-btn" type="button" title="Clear Starred Tables" aria-label="Clear Starred Tables" style={{ display: 'none' }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M12 3 14.65 8.38 20.6 9.24 16.3 13.43 17.31 19.36 12 16.57 6.69 19.36 7.7 13.43 3.4 9.24 9.35 8.38 12 3Z" />
                    <path d="M4 20 20 4" />
                </svg>
            </button>

            <button className="erd-btn" id="delete-table-btn" title="Delete Table">
                <TrashIcon />
            </button>

            <div className="erd-control-popover" id="color-control-popover">
                <button className="erd-btn" id="color-btn" type="button" title="Color Picker" aria-label="Color Picker" aria-haspopup="dialog" aria-controls="color-popup" aria-expanded="false">
                    <ColorPickerIcon />
                </button>
                <div id="color-popup" role="dialog" aria-label="Table appearance">
                    <div className="color-popup-content">
                        <div id="color-dot-row" className="color-dot-container"></div>
                        <div className="color-text-section">
                            <div className="color-swatch-section-label">Header + color badges</div>
                            <div id="color-text-options" className="color-text-options" role="group" aria-label="Table header and table-colored badge text color">
                                <button className="color-text-option" type="button" data-table-text-color="auto" aria-pressed="false" title="Choose text automatically for contrast">
                                    Auto
                                </button>
                                <button className="color-text-option" type="button" data-table-text-color="white" aria-pressed="false" title="Use white header and table-colored badge text">
                                    <span className="color-text-option-dot color-text-option-dot--white" aria-hidden="true" />
                                    White
                                </button>
                                <button className="color-text-option" type="button" data-table-text-color="black" aria-pressed="false" title="Use black header and table-colored badge text">
                                    <span className="color-text-option-dot color-text-option-dot--black" aria-hidden="true" />
                                    Black
                                </button>
                            </div>
                        </div>
                        <div id="color-hex-row">
                            <span>#</span>
                            <input id="color-hex-input" aria-label="Custom table color hex" maxLength="6" spellCheck="false" autoComplete="off" />
                        </div>
                    </div>
                </div>
            </div>

            {relationshipInference && (
                <>
                    <button
                        ref={erdHealthButtonRef}
                        className={`erd-btn erd-btn--toggle schema-quality-control ${hasSchemaScore ? `schema-quality-control--${String(schemaQuality.label || '').toLowerCase().replace(/\s+/g, '-')}` : ''} ${relationshipInference.isOpen ? 'active' : ''}`}
                        id="erd-health-btn"
                        type="button"
                        title={erdHealthLabel}
                        aria-label={erdHealthLabel}
                        aria-expanded={relationshipInference.isOpen}
                        aria-controls="relationship-suggestions-panel"
                        disabled={!hasSchemaScore}
                        onClick={() => relationshipInference.setIsOpen(!relationshipInference.isOpen)}
                    >
                        <span className="schema-quality-control-label">ERD</span>
                        <strong>{hasSchemaScore ? schemaQuality.score : '—'}</strong>
                        {pendingSuggestionCount > 0 && <span className="relationship-inference-count" aria-hidden="true">{pendingSuggestionCount > 99 ? '99+' : pendingSuggestionCount}</span>}
                        {pendingSuggestionCount === 0 && relationshipInference.acceptedCount > 0 && <span className="relationship-inference-accepted-dot" aria-hidden="true" />}
                    </button>
                    <RelationshipSuggestionsPanel inference={relationshipInference} anchorRef={erdHealthButtonRef} />
                </>
            )}
        </div>
    );
}
