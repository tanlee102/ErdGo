/** Registers Prisma syntax, completion, and theme configuration with a Monaco instance. */
export const PRISMA_LIGHT_THEME = 'prisma-light';
export const PRISMA_DARK_THEME = 'prisma-dark';

const SCALAR_TYPES = 'String|Boolean|Int|BigInt|Float|Decimal|DateTime|Json|Bytes|Unsupported';
const BLOCK_KEYWORDS = 'datasource|generator|model|enum|type|view';
const CONFIG_KEYS =
    'provider|url|directUrl|shadowDatabaseUrl|relationMode|schemas|extensions|output|binaryTargets|previewFeatures|engineType|moduleFormat|runtime|generatedFileExtension|importFileExtension|compilerBuild';
const ARGUMENT_KEYS = 'fields|references|onDelete|onUpdate|map|name|sort|length|ops|type|clustered|where';
const REFERENTIAL_ACTIONS = 'Cascade|Restrict|NoAction|SetNull|SetDefault';
const INDEX_OPTIONS = 'Asc|Desc|BTree|Hash|Gist|Gin|SpGist|Brin|Xml|Raw';
const DEFAULT_FUNCTIONS = 'env|dbgenerated|now|autoincrement|auto|cuid|uuid|ulid|nanoid|sequence|raw';

export function configurePrismaMonaco(monaco) {
    if (!monaco?.languages || !monaco?.editor) return;

    const hasPrismaLanguage = monaco.languages.getLanguages().some((language) => language.id === 'prisma');
    if (!hasPrismaLanguage) monaco.languages.register({ id: 'prisma' });

    monaco.languages.setLanguageConfiguration('prisma', {
        comments: {
            lineComment: '//',
            blockComment: ['/*', '*/'],
        },
        brackets: [
            ['{', '}'],
            ['[', ']'],
            ['(', ')'],
        ],
        autoClosingPairs: [
            { open: '{', close: '}' },
            { open: '[', close: ']' },
            { open: '(', close: ')' },
            { open: '"', close: '"' },
        ],
        surroundingPairs: [
            { open: '{', close: '}' },
            { open: '[', close: ']' },
            { open: '(', close: ')' },
            { open: '"', close: '"' },
        ],
    });

    monaco.languages.setMonarchTokensProvider('prisma', {
        defaultToken: '',
        tokenPostfix: '.prisma',
        tokenizer: {
            root: [
                [/\/\/.*$/, 'comment'],
                [/\/\*/, 'comment', '@comment'],
                [new RegExp(`(\\b(?:${BLOCK_KEYWORDS})\\b)(\\s+)([A-Za-z_]\\w*)`), ['keyword', 'white', 'type.declaration']],
                [new RegExp(`^(\\s*)([A-Za-z_]\\w*)(\\s+)(${SCALAR_TYPES})(?=[?\\[]|\\s|$)`), ['white', 'variable', 'white', 'type']],
                [/^(\s*)([A-Za-z_]\w*)(\s+)([A-Za-z_]\w*)(?=[?[]|\s|$)/, ['white', 'variable', 'white', 'type.identifier']],
                [new RegExp(`\\b(?:${SCALAR_TYPES})\\b`), 'type'],
                [new RegExp(`\\b(?:${CONFIG_KEYS})\\b(?=\\s*=)`), 'key'],
                [/(@@?)([A-Za-z_][\w.]*)/, ['delimiter.annotation', 'annotation']],
                [new RegExp(`\\b(?:${ARGUMENT_KEYS})\\b(?=\\s*:)`), 'key'],
                [new RegExp(`\\b(?:${REFERENTIAL_ACTIONS})\\b`), 'constant.relation'],
                [new RegExp(`\\b(?:${INDEX_OPTIONS})\\b`), 'constant.index'],
                [new RegExp(`\\b(?:${DEFAULT_FUNCTIONS})\\b(?=\\s*\\()`), 'function'],
                [/"([^"\\]|\\.)*$/, 'string.invalid'],
                [/"/, 'string', '@string'],
                [/\b(?:true|false|null)\b/, 'constant'],
                [/\b-?\d+(?:\.\d+)?\b/, 'number'],
                [/[?[\]]/, 'operator'],
                [/[{}()[\],.=]/, 'delimiter'],
                [/[A-Za-z_]\w*/, 'identifier'],
            ],
            comment: [
                [/[^/*]+/, 'comment'],
                [/\*\//, 'comment', '@pop'],
                [/[/*]/, 'comment'],
            ],
            string: [
                [/[^\\"]+/, 'string'],
                [/\\./, 'string.escape'],
                [/"/, 'string', '@pop'],
            ],
        },
    });

    monaco.editor.defineTheme(PRISMA_LIGHT_THEME, {
        base: 'vs',
        inherit: true,
        rules: [
            { token: 'keyword.prisma', foreground: '0550AE', fontStyle: 'bold' },
            { token: 'type.declaration.prisma', foreground: '087F8C', fontStyle: 'bold' },
            { token: 'variable.prisma', foreground: '1F5A94' },
            { token: 'type.prisma', foreground: '267F99' },
            { token: 'type.identifier.prisma', foreground: '087F8C' },
            { token: 'key.prisma', foreground: '315F87' },
            { token: 'annotation.prisma', foreground: '8A6500', fontStyle: 'bold' },
            { token: 'delimiter.annotation.prisma', foreground: '9A7200' },
            { token: 'function.prisma', foreground: '795E26' },
            { token: 'string.prisma', foreground: 'A65320' },
            { token: 'string.escape.prisma', foreground: '8C4A22' },
            { token: 'number.prisma', foreground: '067A63' },
            { token: 'constant.prisma', foreground: '0550AE' },
            { token: 'constant.relation.prisma', foreground: '0550AE', fontStyle: 'bold' },
            { token: 'constant.index.prisma', foreground: '067A63' },
            { token: 'comment.prisma', foreground: '5A7D4E', fontStyle: 'italic' },
            { token: 'operator.prisma', foreground: '4B5563' },
        ],
        colors: {
            'editor.background': '#FBFCFE',
            'editor.foreground': '#24292F',
            'editorLineNumber.foreground': '#9AA4B2',
            'editorLineNumber.activeForeground': '#52606D',
            'editor.lineHighlightBackground': '#F3F6FA',
            'editor.selectionBackground': '#CFE4FF',
            'editor.inactiveSelectionBackground': '#E5EFFB',
            'editorIndentGuide.background1': '#E4E9EF',
            'editorIndentGuide.activeBackground1': '#B8C2CC',
        },
    });

    monaco.editor.defineTheme(PRISMA_DARK_THEME, {
        base: 'vs-dark',
        inherit: true,
        rules: [
            { token: 'keyword.prisma', foreground: '569CD6' },
            { token: 'type.declaration.prisma', foreground: '4EC9B0', fontStyle: 'bold' },
            { token: 'variable.prisma', foreground: '9CDCFE' },
            { token: 'type.prisma', foreground: '4EC9B0' },
            { token: 'type.identifier.prisma', foreground: '4EC9B0' },
            { token: 'key.prisma', foreground: '9CDCFE' },
            { token: 'annotation.prisma', foreground: 'DCDCAA' },
            { token: 'delimiter.annotation.prisma', foreground: 'DCDCAA' },
            { token: 'function.prisma', foreground: 'DCDCAA' },
            { token: 'string.prisma', foreground: 'CE9178' },
            { token: 'string.escape.prisma', foreground: 'D7BA7D' },
            { token: 'number.prisma', foreground: 'B5CEA8' },
            { token: 'constant.prisma', foreground: '569CD6' },
            { token: 'constant.relation.prisma', foreground: '569CD6' },
            { token: 'constant.index.prisma', foreground: 'B5CEA8' },
            { token: 'comment.prisma', foreground: '6A9955' },
            { token: 'operator.prisma', foreground: 'D4D4D4' },
        ],
        colors: {},
    });
}
