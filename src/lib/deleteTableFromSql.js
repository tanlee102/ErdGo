import { parseAST } from './parse-ast/parseAst.js';
import {
    buildIdentifierDisplayContext,
    effectiveIdentifierParts,
    identifierKey,
    identifierLeafKey,
    identifierPartsEquivalent,
    identifierPartsFrom,
} from './sqlIdentifierIdentity.js';

/**
 * Position-based table deletion using AST positions for precise removal
 * This is much more accurate than regex-based deletion
 */

function collectAstIdentifierParts(ast) {
    const groups = [];

    (ast?.tables || []).forEach((table) => {
        groups.push(identifierPartsFrom(table));
        (table.columns || []).forEach((column) => {
            if (column?.references?.table) groups.push(identifierPartsFrom(column.references.table, column.references.tableParts));
        });
        (table.constraints || []).forEach((constraint) => {
            if (constraint?.kind === 'foreign' && constraint.references?.table) {
                groups.push(identifierPartsFrom(constraint.references.table, constraint.references.tableParts));
            }
        });
    });

    (ast?.alters || []).forEach((alter) => {
        if (alter?.table) groups.push(identifierPartsFrom(alter.table, alter.tableParts));
        if (alter?.references?.table) groups.push(identifierPartsFrom(alter.references.table, alter.references.tableParts));
    });

    return groups.filter((parts) => parts.length > 0);
}

function createTableNameMatcher(ast, tableName) {
    const normalizedTargetName = String(tableName || '').trim().toLowerCase();
    const targetParts = identifierPartsFrom(tableName);
    const tableDisplayContext = buildIdentifierDisplayContext(ast?.tables || [], { schemaAware: true });
    const displayedTargetTables = (ast?.tables || []).filter((table) => {
        const meta = tableDisplayContext.get(table);
        return String(meta?.displayName || '').toLowerCase() === normalizedTargetName;
    });
    const targetTableSet = new Set(displayedTargetTables);
    const targetIdentityParts = displayedTargetTables.length > 0
        ? displayedTargetTables.map((table) => tableDisplayContext.get(table)?.sourceParts || identifierPartsFrom(table))
        : [targetParts];
    const tableLeafCounts = new Map();
    (ast?.tables || []).forEach((table) => {
        const leafKey = identifierLeafKey(identifierPartsFrom(table));
        tableLeafCounts.set(leafKey, (tableLeafCounts.get(leafKey) || 0) + 1);
    });

    const leafToFullKeys = new Map();
    collectAstIdentifierParts(ast).forEach((parts) => {
        const leafKey = identifierLeafKey(parts);
        if (!leafKey) return;
        if (!leafToFullKeys.has(leafKey)) leafToFullKeys.set(leafKey, new Set());
        leafToFullKeys.get(leafKey).add(identifierKey(effectiveIdentifierParts(parts)));
    });

    function matchesIdentityParts(candidateParts) {
        if (!candidateParts || candidateParts.length === 0) return false;

        if (targetIdentityParts.some((parts) => identifierPartsEquivalent(candidateParts, parts))) {
            return true;
        }

        const candidateLeafKey = identifierLeafKey(candidateParts);
        const matchesTargetLeaf = candidateLeafKey && candidateLeafKey === identifierLeafKey(targetParts);
        if (!matchesTargetLeaf) return false;

        // If a local table resolved from the display name is the only table
        // with this leaf, unqualified FK references should follow that table.
        if (displayedTargetTables.length > 0 && candidateParts.length === 1 && tableLeafCounts.get(candidateLeafKey) === 1) {
            return true;
        }

        // Cross-tab FK cleanup has no local CREATE TABLE to disambiguate. A
        // leaf-only ERD label is still safe when this SQL tab only mentions
        // one effective object with that leaf.
        const fullKeysForLeaf = leafToFullKeys.get(candidateLeafKey);
        return targetParts.length === 1 && fullKeysForLeaf?.size === 1;
    }

    return {
        matchesTable(table) {
            if (targetTableSet.has(table)) return true;
            return matchesIdentityParts(identifierPartsFrom(table));
        },
        matchesName(name, parts = null) {
            return matchesIdentityParts(identifierPartsFrom(name, parts));
        },
    };
}

function createColumnRemovalTracker() {
    const entries = [];

    return {
        add(table, columnsToRemove) {
            if (!table || !Array.isArray(columnsToRemove) || columnsToRemove.length === 0) return;
            entries.push({
                parts: identifierPartsFrom(table),
                leafKey: identifierLeafKey(identifierPartsFrom(table)),
                columns: columnsToRemove,
            });
        },
        get(tableName, tableParts = null) {
            const candidateParts = identifierPartsFrom(tableName, tableParts);
            const exact = entries.find((entry) => identifierPartsEquivalent(candidateParts, entry.parts));
            if (exact) return exact.columns;
            if (candidateParts.length !== 1) return null;

            const candidateLeafKey = identifierLeafKey(candidateParts);
            const leafMatches = entries.filter((entry) => entry.leafKey === candidateLeafKey);
            return leafMatches.length === 1 ? leafMatches[0].columns : null;
        },
    };
}

function warningReferencesMatchedTable(error, tableNameMatcher) {
    if (error?.severity !== 'warning') return false;
    const match = String(error.message || '').match(/references table '([^']+)'/i);
    return !!match && tableNameMatcher.matchesName(match[1]);
}

function quoteIdentifierPartForSql(value) {
    return `"${String(value || '').replace(/"/g, '""')}"`;
}

function identifierSqlName(name, parts = null) {
    const identifierParts = identifierPartsFrom(name, parts);
    if (identifierParts.length === 0) return String(name || '');
    return identifierParts
        .map((part) => {
            if (part.raw) return part.raw;
            return part.quoted ? quoteIdentifierPartForSql(part.value) : part.value;
        })
        .join('.');
}

function referenceSqlName(reference) {
    return identifierSqlName(reference?.table, reference?.tableParts);
}

/**
 * Delete a table and all its references using AST position information
 * @param {string} sql - The SQL string
 * @param {string} tableName - Name of the table to delete
 * @param {object} options
 * @param {boolean} options.removeReferencesWhenTargetMissing - Also remove
 * foreign-key references when the target table belongs to another SQL tab.
 * @param {boolean} options.preserveReferencingColumns - Remove foreign-key
 * constraints without dropping the dependent columns or tables.
 * @returns {string} - SQL with table and references removed
 */
export function deleteTableFromSql(sql, tableName, { removeReferencesWhenTargetMissing = false, preserveReferencingColumns = false } = {}) {
    if (typeof sql !== 'string' || !sql.trim()) return sql;
    if (!tableName || typeof tableName !== 'string') return sql;

    try {
        // Parse the SQL to get AST with position information
        const { ast, errors } = parseAST(sql);
        const tableNameMatcher = createTableNameMatcher(ast, tableName);

        if (errors && errors.length > 0) {
            const expectedCrossTabReferenceWarnings = removeReferencesWhenTargetMissing ? errors.filter((error) => warningReferencesMatchedTable(error, tableNameMatcher)) : [];
            const unexpectedErrors = errors.filter((error) => !expectedCrossTabReferenceWarnings.includes(error));
            if (unexpectedErrors.length > 0) {
                console.warn('AST parsing errors:', unexpectedErrors);
            }
            // Continue anyway - we can still work with partial AST
        }

        // Collect all positions that need to be removed
        const positionsToRemove = [];

        // 1. Find the main table definition
        const targetTable = ast.tables.find((table) => tableNameMatcher.matchesTable(table));

        // A tab can own references to a table declared in another tab. In that
        // case continue with reference cleanup without trying to remove a local
        // table definition.
        if (!targetTable && !removeReferencesWhenTargetMissing) {
            return sql;
        }

        if (targetTable?.position) {
            positionsToRemove.push({
                start: targetTable.position.start,
                end: targetTable.position.end,
                type: 'table',
                name: targetTable.name,
            });
        }

        // Create a map to track which columns will be removed from each table
        const tableColumnRemovalMap = createColumnRemovalTracker();

        // 2. Find ALTER statements that reference this table directly
        ast.alters.forEach((alter) => {
            if (!alter.position) return;

            // Check if ALTER references the target table directly
            if (alter.table && tableNameMatcher.matchesName(alter.table, alter.tableParts)) {
                positionsToRemove.push({
                    start: alter.position.start,
                    end: alter.position.end,
                    type: 'alter',
                    action: alter.action,
                    table: alter.table,
                });
                return;
            }

            // Check if ALTER adds foreign key to the target table
            if (alter.references && alter.references.table && tableNameMatcher.matchesName(alter.references.table, alter.references.tableParts)) {
                positionsToRemove.push({
                    start: alter.position.start,
                    end: alter.position.end,
                    type: 'alter_fk_reference',
                    action: alter.action,
                    referencedTable: alter.references.table,
                });
                return;
            }
        });

        // 3. Find tables that have foreign key columns referencing the target table
        ast.tables.forEach((table) => {
            if (tableNameMatcher.matchesTable(table)) return; // Skip the target table itself

            const columnsToRemove = [];
            const columnNamesToRemove = [];

            // Check column-level FK references
            table.columns.forEach((column, columnIndex) => {
                if (column.references && column.references.table && tableNameMatcher.matchesName(column.references.table, column.references.tableParts)) {
                    columnsToRemove.push(columnIndex);
                    columnNamesToRemove.push(column.name.toLowerCase());
                }
            });

            // Check table-level FK constraints
            if (table.constraints) {
                table.constraints.forEach((constraint) => {
                    if (constraint && constraint.kind === 'foreign' && constraint.references && constraint.references.table && tableNameMatcher.matchesName(constraint.references.table, constraint.references.tableParts)) {
                        // Add columns from this FK constraint to removal list
                        if (constraint.columns) {
                            constraint.columns.forEach((colName) => {
                                const columnIndex = table.columns.findIndex((col) => col.name.toLowerCase() === colName.toLowerCase());
                                if (columnIndex !== -1 && !columnsToRemove.includes(columnIndex)) {
                                    columnsToRemove.push(columnIndex);
                                    columnNamesToRemove.push(colName.toLowerCase());
                                }
                            });
                        }
                    }
                });
            }

            // If we have columns to remove, we need to handle this table
            if (columnsToRemove.length > 0) {
                if (preserveReferencingColumns) {
                    // Tab-aware deletion removes the target table and FK
                    // constraints, not unrelated dependent columns. Regenerate
                    // the table body with REFERENCES removed.
                    positionsToRemove.push({
                        start: table.position.start,
                        end: table.position.end,
                        type: 'table_without_fk_references',
                        name: table.name,
                        referencedTable: tableName,
                        tableNameMatcher,
                    });
                    return;
                }

                // Store column removal info for later ALTER constraint checking
                tableColumnRemovalMap.add(table, columnNamesToRemove);

                // Check if removing these columns would leave the table empty or with only non-essential columns
                const remainingColumns = table.columns.filter((_, index) => !columnsToRemove.includes(index));

                if (remainingColumns.length === 0) {
                    // Table becomes empty, remove it entirely
                    positionsToRemove.push({
                        start: table.position.start,
                        end: table.position.end,
                        type: 'table',
                        name: table.name,
                    });
                } else {
                    // Table has remaining columns, regenerate without FK columns
                    positionsToRemove.push({
                        start: table.position.start,
                        end: table.position.end,
                        type: 'table_with_fk_columns',
                        name: table.name,
                        columnsToRemove: columnsToRemove,
                        columnNamesToRemove: columnNamesToRemove, // Add this for ALTER constraint checking
                    });
                }
            }
        });

        // 4. Check for ALTER constraints that reference removed columns
        ast.alters.forEach((alter) => {
            if (!alter.position) return;

            // Skip if already marked for removal
            const alreadyMarked = positionsToRemove.some((pos) => pos.start === alter.position.start && pos.end === alter.position.end);
            if (alreadyMarked) return;

            // Check if ALTER constraint references columns that will be removed
            if (alter.columns && alter.table) {
                const columnsToRemove = tableColumnRemovalMap.get(alter.table, alter.tableParts);

                if (columnsToRemove && columnsToRemove.length > 0) {
                    // Check if this ALTER constraint references any of the columns that will be removed
                    const constraintReferencesRemovedColumn = alter.columns.some((colName) => columnsToRemove.includes(colName.toLowerCase()));

                    if (constraintReferencesRemovedColumn) {
                        positionsToRemove.push({
                            start: alter.position.start,
                            end: alter.position.end,
                            type: 'alter_references_removed_column',
                            action: alter.action,
                            table: alter.table,
                        });
                    }
                }
            }
        });

        // 5. Process all positions and create a comprehensive plan
        if (positionsToRemove.length === 0) {
            return sql;
        }

        const allRanges = [];

        for (const position of positionsToRemove) {
            if (!position.start || !position.end) continue;

            let replacementText = '';

            if (position.type === 'table_with_fk_columns') {
                // Generate new table definition without FK columns
                replacementText = generateTableWithoutFKColumns(position, ast);
            } else if (position.type === 'table_without_fk_references') {
                replacementText = generateTableWithoutFKReferences(position, ast);
            }
            // For other types (table, alter, etc.), we completely remove them (empty replacement)

            allRanges.push({
                start: position.start.idx,
                end: position.end.idx,
                type: position.type,
                name: position.name || position.table,
                replacement: replacementText,
            });
        }

        // 6. Sort ranges by start position (descending) to process from end to beginning
        allRanges.sort((a, b) => b.start - a.start);

        // 7. Apply all changes from end to beginning
        let modifiedSql = sql;

        for (const range of allRanges) {
            if (range.start >= 0 && range.end > range.start && range.end <= modifiedSql.length) {
                modifiedSql = modifiedSql.slice(0, range.start) + range.replacement + modifiedSql.slice(range.end);
            }
        }

        // 8. Clean up the result
        modifiedSql = cleanupSql(modifiedSql);

        return modifiedSql;
    } catch (error) {
        console.error('Position-based deletion failed:', error);
        // Fallback to original SQL to avoid corruption
        return sql;
    }
}

/**
 * Generate a new table definition without specific FK columns
 * @param {object} position - Position info with columnsToRemove
 * @param {object} ast - The full AST for reference
 * @returns {string} - New table definition
 */
function generateTableWithoutFKColumns(position, ast) {
    // Find the table in AST
    const table = ast.tables.find((t) => t.name === position.name);
    if (!table || !table.columns) return '';

    // Create new column list without the FK columns
    const newColumns = table.columns.filter((_, index) => !position.columnsToRemove.includes(index));

    // If no columns left, return empty (table will be removed)
    if (newColumns.length === 0) {
        return '';
    }

    // Generate new table definition
    return regenerateTableDefinition(table, newColumns);
}

function generateTableWithoutFKReferences(position, ast) {
    const table = ast.tables.find((item) => item.name === position.name);
    if (!table || !table.columns) return '';

    const matchesReferencedTable = (reference) => {
        if (!reference?.table) return false;
        if (position.tableNameMatcher) return position.tableNameMatcher.matchesName(reference.table, reference.tableParts);
        return String(reference.table || '').toLowerCase() === String(position.referencedTable || '').toLowerCase();
    };
    const columns = table.columns.map((column) => {
        if (matchesReferencedTable(column.references)) {
            return { ...column, references: null };
        }
        return column;
    });
    const constraints = (table.constraints || []).filter((constraint) => constraint?.kind !== 'foreign' || !matchesReferencedTable(constraint.references));

    return regenerateTableDefinition(table, columns, constraints);
}

/**
 * Regenerate a table definition with specific columns
 * @param {object} table - Original table from AST
 * @param {array} columns - Columns to include
 * @returns {string} - New table definition
 */
function regenerateTableDefinition(table, columns, constraintsOverride = null) {
    let result = `CREATE TABLE ${identifierSqlName(table.name, table.nameParts)} (\n`;

    // Add columns
    const columnDefs = columns.map((col) => {
        let colDef = `    ${col.name} ${col.type}`;

        if (col.notNull) colDef += ' NOT NULL';
        if (col.unique) colDef += ' UNIQUE';
        if (col.primary) colDef += ' PRIMARY KEY';
        if (col.default !== null) colDef += ` DEFAULT ${col.default}`;
        if (col.check) colDef += ` CHECK (${col.check})`;
        if (col.references) {
            colDef += ` REFERENCES ${referenceSqlName(col.references)}`;
            if (col.references.columns && col.references.columns.length > 0) {
                colDef += `(${col.references.columns.join(', ')})`;
            }
        }

        return colDef;
    });

    result += columnDefs.join(',\n');

    // Add table-level constraints (excluding those that reference removed columns)
    const tableConstraints = constraintsOverride || table.constraints || [];
    if (tableConstraints.length > 0) {
        const validConstraints = tableConstraints
            .filter((constraint) => {
                if (!constraint || !constraint.columns) return true;

                // Check if all constraint columns still exist
                return constraint.columns.every((colName) => columns.some((col) => col.name.toLowerCase() === colName.toLowerCase()));
            })
            .filter(Boolean); // Remove null constraints

        if (validConstraints.length > 0) {
            const constraintDefs = validConstraints
                .map((constraint) => {
                    if (constraint.kind === 'primary') {
                        return `    PRIMARY KEY (${constraint.columns.join(', ')})`;
                    } else if (constraint.kind === 'unique') {
                        return `    UNIQUE (${constraint.columns.join(', ')})`;
                    } else if (constraint.kind === 'foreign') {
                        let def = `    FOREIGN KEY (${constraint.columns.join(', ')})`;
                        def += ` REFERENCES ${referenceSqlName(constraint.references)}`;
                        if (constraint.references.columns && constraint.references.columns.length > 0) {
                            def += `(${constraint.references.columns.join(', ')})`;
                        }
                        return def;
                    } else if (constraint.kind === 'check') {
                        return `    CHECK (${constraint.expression})`;
                    }
                    return null;
                })
                .filter(Boolean);

            if (constraintDefs.length > 0) {
                result += ',\n' + constraintDefs.join(',\n');
            }
        }
    }

    result += '\n);';
    return result;
}

/**
 * Clean up SQL after deletions
 * @param {string} sql - SQL to clean up
 * @returns {string} - Cleaned SQL
 */
function cleanupSql(sql) {
    return (
        sql
            // Remove multiple consecutive newlines
            .replace(/\n{3,}/g, '\n\n')
            // Remove trailing whitespace from lines
            .replace(/[ \t]+$/gm, '')
            // Remove leading/trailing whitespace from the entire string
            .trim() +
        // Ensure we end with a newline if there's content
        (sql.trim() ? '\n' : '')
    );
}

/**
 * Get information about what would be deleted (for preview/confirmation)
 * @param {string} sql - The SQL string
 * @param {string} tableName - Name of the table to delete
 * @returns {object} - Information about what would be deleted
 */
export function getTableDeletionInfo(sql, tableName) {
    if (typeof sql !== 'string' || !sql.trim()) return { items: [] };
    if (!tableName || typeof tableName !== 'string') return { items: [] };

    try {
        const { ast, errors } = parseAST(sql);
        const items = [];
        const tableNameMatcher = createTableNameMatcher(ast, tableName);

        // Main table
        const targetTable = ast.tables.find((table) => tableNameMatcher.matchesTable(table));

        if (targetTable) {
            items.push({
                type: 'table',
                name: targetTable.name,
                description: `Table definition with ${targetTable.columns.length} columns`,
            });
        }

        // ALTER statements
        ast.alters.forEach((alter) => {
            if (alter.table && tableNameMatcher.matchesName(alter.table, alter.tableParts)) {
                items.push({
                    type: 'alter',
                    name: `ALTER TABLE ${alter.table}`,
                    description: `${alter.action} constraint`,
                });
            }

            if (alter.references && alter.references.table && tableNameMatcher.matchesName(alter.references.table, alter.references.tableParts)) {
                items.push({
                    type: 'alter_reference',
                    name: `ALTER TABLE ${alter.table}`,
                    description: `Foreign key reference to ${tableName}`,
                });
            }
        });

        // Tables with FK columns
        ast.tables.forEach((table) => {
            if (tableNameMatcher.matchesTable(table)) return;

            // Preview mirrors deletion behavior: report FK columns/constraints
            // that will lose their reference, but dependent tables stay in place.
            const fkColumns = table.columns.filter((column) => column.references && column.references.table && tableNameMatcher.matchesName(column.references.table, column.references.tableParts));

            if (fkColumns.length > 0) {
                items.push({
                    type: 'foreign_key_columns',
                    table: table.name,
                    columns: fkColumns.map((column) => column.name),
                    description: `${table.name}(${fkColumns.map((column) => column.name).join(', ')})`,
                });
            }

            const foreignKeyConstraints = (table.constraints || []).filter(
                (constraint) => constraint?.kind === 'foreign' && constraint.references?.table && tableNameMatcher.matchesName(constraint.references.table, constraint.references.tableParts),
            );

            foreignKeyConstraints.forEach((constraint) => {
                items.push({
                    type: 'foreign_key_constraint',
                    table: table.name,
                    columns: constraint.columns || [],
                    description: `${table.name}(${(constraint.columns || []).join(', ')})`,
                });
            });
        });

        return {
            items,
            errors: errors || [],
        };
    } catch (error) {
        return {
            items: [],
            errors: [{ message: error.message }],
        };
    }
}
