/** Browser document kinds and their owning workspaces. Missing kinds are legacy SQL documents. */
export const FILE_KINDS = Object.freeze({
    SQL_ERD: 'sql-erd',
    PRISMA_ERD: 'prisma-erd',
    ERD_BUILDER: 'erd-builder',
});

export function getDocumentKind(document) {
    return document?.kind || FILE_KINDS.SQL_ERD;
}

export function getDocumentRoute(document) {
    const bases = { [FILE_KINDS.SQL_ERD]: '/e', [FILE_KINDS.PRISMA_ERD]: '/prisma-to-erd', [FILE_KINDS.ERD_BUILDER]: '/erd-builder' };
    return `${bases[getDocumentKind(document)] || '/e'}/${encodeURIComponent(document.id)}`;
}

export function getDocumentKindLabel(document) {
    return { [FILE_KINDS.SQL_ERD]: 'SQL to ERD', [FILE_KINDS.PRISMA_ERD]: 'Prisma to ERD', [FILE_KINDS.ERD_BUILDER]: 'ERD Builder' }[getDocumentKind(document)] || 'Diagram';
}
