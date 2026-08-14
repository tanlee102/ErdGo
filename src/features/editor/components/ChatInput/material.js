import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import { parseResponse, applyDiffs } from '@/features/editor/lib/diffParser.js';
import { formatAiTabWorkspace } from '@/features/editor/lib/aiTabProtocol.js';

// Compact and stateless: prioritize parser grammar and edit logic over a SQL syntax catalog.
export const diffSystemInstruction = `You are ERD Go's SQL edit engine. Return the smallest correct, parser-safe response for the supplied request and SQL context.

= DECISION =
- Each request is isolated. Read only the supplied current SQL or tab workspace and user request.
- For an edit with a tab workspace, return <tab_changes>. For an edit without one, return <diffs>. Never combine the formats.
- For a question that needs no edit, return brief plain text with no XML block.
- Do not ask follow-up questions. Make a reasonable assumption and mention it briefly after the XML.
- Never use Markdown fences or put text before the XML. Put at most two short explanation sentences after it.

= EDIT LOGIC =
- Preserve the existing SQL dialect, naming, quoting, indentation, and unrelated content. If SQL is empty, default to SQLite.
- Change only what the user requested. Prefer minimal edits over rewriting a table, tab, or document.
- Produce valid SQL for the detected dialect. Prefer ordinary schema DDL and direct INSERT/UPDATE/DELETE. If a request cannot be represented safely, explain the limit and suggest the closest safe alternative instead of fabricating an edit.

= TAB WORKSPACE =
The JSON workspace is authoritative. Included tabs are active and have stable ids, titles, order, and tab-local SQL; inactive drafts are omitted.
- If tabs is empty, do not return an edit. Briefly tell the user to activate a tab.
- Never invent an existing ID, merge SQL across tabs, or use a title as an id. Copy id/source/after exactly from the workspace.
- Use tab titles to understand user phrases. A title is not an id. When a unique title is the only reference, use title/source_title/after_title exactly; never guess between duplicate titles.
- Scope every edit to its owning tab. Each <search> must be a unique, character-for-character match in that tab.
- Allowed actions inside one <tab_changes> block:
  <update_tab id="exact-tab-id"><diff><search>exact tab SQL</search><replace>replacement SQL</replace></diff></update_tab>
  <create_tab title="Title" after="exact-tab-id" inactive="false"><sql>complete SQL</sql></create_tab>
  <rename_tab id="exact-tab-id">New title</rename_tab>
  <move_tab id="exact-tab-id" after="exact-tab-id" />
  <set_inactive id="exact-tab-id" value="true" /> (use value="false" to activate)
  <delete_tab id="exact-tab-id" />
- Omit after only to append. Create no empty tab unless requested; put its complete initial SQL in <create_tab> and do not update it in the same response. Delete only when explicitly requested. XML-escape attribute values.
- For moving complete data statements to a new tab, prefer <move_statements source="exact-tab-id" statement="INSERT" title="Sample Data" after="exact-tab-id" inactive="false" />. Use statement="DML" only for all INSERT/UPDATE/DELETE statements.
- A <move_statements> action owns the source tab change: do not also update that source, do not overlap INSERT plus DML, and do not duplicate the SQL with a giant <update_tab> plus <create_tab>.
- Return one complete, closed <tab_changes> block with every tag closed.

= DOCUMENT DIFF =
For an edit without a workspace, return exactly:
<diffs><diff><search>exact current SQL</search><replace>replacement SQL</replace></diff></diffs>
Short explanation.

- <search> must be the smallest unique, character-for-character match. Add nearby lines only when needed for uniqueness.
- To insert between text, include the surrounding text in both search and replace. To delete, omit the target from replace.
- To append, use <search>END</search>. For separate edits, add separate <diff> elements.
- Return at least one complete <diff>; close every tag. Never return the full SQL unless the request truly replaces all of it.`;

// Cost controls: keep output bounded and disable/minimize model reasoning where supported.
const DEFAULTS = Object.freeze({
    threshold: 0.75,
    temperature: 0.2,
    maxOutputTokens: 4096,
});

export function buildGeminiGenerationConfig(model, { temperature = DEFAULTS.temperature, maxOutputTokens = DEFAULTS.maxOutputTokens } = {}) {
    const isGemini3 = /^gemini-3(?:[.-]|$)/.test(String(model || ''));

    if (isGemini3) {
        return {
            systemInstruction: diffSystemInstruction,
            maxOutputTokens,
            thinkingConfig: {
                thinkingLevel: String(model).includes('-pro') ? ThinkingLevel.LOW : ThinkingLevel.MINIMAL,
            },
        };
    }

    return {
        systemInstruction: diffSystemInstruction,
        temperature,
        maxOutputTokens,
        thinkingConfig: { thinkingBudget: 0 },
    };
}

export const geminiCode = async (sqlInput, prompt, model, key, options = {}) => {
    const { threshold = DEFAULTS.threshold, temperature = DEFAULTS.temperature, maxOutputTokens = DEFAULTS.maxOutputTokens, tabWorkspace = null, repairReason = null } = options;

    try {
        const ai = new GoogleGenAI({ apiKey: key });

        const response = await ai.models.generateContent({
            model,
            // In tab mode the workspace JSON is authoritative. The combined SQL
            // is still passed as `suggestedCode` for compatibility, but the AI
            // must answer with tab-local XML operations.
            contents: `${
                tabWorkspace
                    ? `User request: ${prompt}\n\nCurrent tab workspace (authoritative):\n${formatAiTabWorkspace(tabWorkspace)}`
                    : `User request: ${prompt}\n\nCurrent SQL:\n${sqlInput}`
            }${repairReason ? `\n\n${repairReason}` : ''}`,
            config: buildGeminiGenerationConfig(model, { temperature, maxOutputTokens }),
        });

        if (!response?.text) {
            throw new Error('No response from Gemini API');
        }

        const rawResponse = response.text.trim();
        const { hasDiffs, diffs, hasTabChanges, tabChanges, explanation } = parseResponse(rawResponse);

        if (hasTabChanges) {
            return {
                success: true,
                isConversational: false,
                suggestedCode: sqlInput,
                tabChanges,
                explanation,
                diffs: [],
            };
        }

        // No <diffs> block → conversational response, return SQL unchanged.
        if (!hasDiffs) {
            return {
                success: true,
                isConversational: true,
                suggestedCode: sqlInput,
                tabChanges: null,
                explanation,
                diffs: [],
            };
        }

        const result = applyDiffs(sqlInput, diffs, threshold);

        return {
            success: result.success,
            isConversational: false,
            suggestedCode: result.result,
            tabChanges: null,
            explanation,
            diffs,
            applied: result.applied,
            failed: result.failed,
            stats: result.stats,
        };
    } catch (error) {
        throw new Error(error.message || 'Unknown error');
    }
};
