/** Draggable and collapsible divider between the Prisma source editor and ERD canvas. */
import ChevronLeftIcon from '@/icons/ChevronLeftIcon';
import ChevronRightIcon from '@/icons/ChevronRightIcon';

const PrismaSplitter = ({ onMouseDown, toggleButtonText, toggleButtonTitle, onToggleClick, splitterRef }) => {
    const icon = toggleButtonText === '>' ? <ChevronRightIcon width="12" height="12" /> : <ChevronLeftIcon width="12" height="12" />;

    return (
        <div className="panel-splitter prisma-erd-splitter" ref={splitterRef} onMouseDown={onMouseDown}>
            <button
                type="button"
                className="splitter-toggle-btn prisma-erd-splitter-toggle"
                onClick={onToggleClick}
                title={toggleButtonTitle}
                aria-label={toggleButtonTitle}
            >
                {icon}
            </button>
        </div>
    );
};

export default PrismaSplitter;
