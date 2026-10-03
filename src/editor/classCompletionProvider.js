/**
 * Monaco PHP class-completion provider.
 *
 * Created with a getClasses() callback so the registered provider always
 * sees the latest scan results without needing re-registration when the
 * underlying list changes.
 */

const MAX_RESULTS = 200

// Ranking buckets — lower number sorts higher in the menu.
// We multiply with a per-bucket prefix so sortText comparison stays stable.
const BUCKET = {
  EXACT_APP: 1,
  EXACT_PRIORITY_VENDOR: 2,
  EXACT_VENDOR: 3,
  PREFIX_APP: 4,
  PREFIX_PRIORITY_VENDOR: 5,
  PREFIX_VENDOR: 6,
}

const PRIORITY_NAMESPACE_PREFIXES = [
  'Illuminate\\Support',
  'Illuminate\\Database\\Eloquent',
  'Illuminate\\Http',
  'Illuminate\\Console',
  'Carbon',
]

function isPriorityNamespace(ns) {
  return PRIORITY_NAMESPACE_PREFIXES.some(
    (p) => ns === p || ns.startsWith(p + '\\')
  )
}

/**
 * Extract `use Foo\Bar;` imports already present in the buffer.
 * Returns a Set of FQCNs (no leading backslash) and the line number after
 * which we should insert new use statements.
 */
function parseImports(model) {
  const imported = new Set()
  let lastUseLine = 0
  let phpOpenLine = 0

  const lineCount = model.getLineCount()
  // Cap the scan; users rarely have thousands of header lines, and we never
  // want completion to feel sluggish on huge buffers.
  const limit = Math.min(lineCount, 400)

  for (let i = 1; i <= limit; i++) {
    const text = model.getLineContent(i)
    if (/^\s*<\?(php|=)\b/.test(text)) {
      phpOpenLine = i
      continue
    }
    const m = text.match(/^\s*use\s+([A-Za-z_][A-Za-z0-9_\\]*)\s*(?:as\s+[A-Za-z_][A-Za-z0-9_]*)?\s*;/)
    if (m) {
      imported.add(m[1].replace(/^\\+/, ''))
      lastUseLine = i
    } else if (lastUseLine > 0) {
      // Once we've passed the use block and hit a non-use, non-blank line,
      // stop scanning for imports — keeps the parse cheap.
      if (text.trim() !== '' && !/^\s*\/\//.test(text)) break
    }
  }

  return { imported, lastUseLine, phpOpenLine }
}

/**
 * Pull the identifier the user is currently typing from the line up to
 * the cursor. Also detect the contextual `use` prefix.
 */
function readContext(lineUpToCursor) {
  const useMatch = lineUpToCursor.match(/^\s*use\s+([A-Za-z0-9_\\]*)$/)
  if (useMatch) return { kind: 'use', prefix: useMatch[1] }

  // Otherwise, take the trailing identifier (possibly partial).
  const idMatch = lineUpToCursor.match(/([A-Za-z_][A-Za-z0-9_\\]*)$/)
  return { kind: 'general', prefix: idMatch ? idMatch[1] : '' }
}

function bucketFor(cls, prefix) {
  const isAppSrc = cls.source === 'app'
  const priority = isPriorityNamespace(cls.namespace)
  const exact = cls.shortName.toLowerCase() === prefix.toLowerCase()

  if (exact) {
    if (isAppSrc) return BUCKET.EXACT_APP
    if (priority) return BUCKET.EXACT_PRIORITY_VENDOR
    return BUCKET.EXACT_VENDOR
  }
  if (isAppSrc) return BUCKET.PREFIX_APP
  if (priority) return BUCKET.PREFIX_PRIORITY_VENDOR
  return BUCKET.PREFIX_VENDOR
}

function makeSortText(bucket, fqcn) {
  // Pad bucket to 2 digits, then FQCN. Lexicographic order = bucket-first.
  return `${String(bucket).padStart(2, '0')}_${fqcn}`
}

/**
 * Filter classes by what the user is typing.
 *
 * For `use` context: match against the FQCN (case-insensitive prefix).
 * For general context: match against the short name (case-insensitive prefix).
 * Empty prefix → return everything (Monaco caps display itself, but we still
 * cap to MAX_RESULTS for renderer-side perf).
 */
function filterClasses(classes, ctx) {
  const prefix = ctx.prefix.toLowerCase()
  if (ctx.kind === 'use') {
    const stripped = prefix.replace(/^\\+/, '')
    return classes.filter((c) => c.fqcn.toLowerCase().startsWith(stripped))
  }
  if (!prefix) return classes
  return classes.filter((c) => c.shortName.toLowerCase().startsWith(prefix))
}

/**
 * Build a Monaco CompletionItem for a class in `general` (non-use) context.
 *
 * Inserts the short name at the cursor; the `use` statement is added by a
 * post-completion command (registered in Editor.vue) so its edit runs AFTER
 * the cursor edit and can never overlap with it. Skips the command if the
 * FQCN is already imported.
 */
function buildItemGeneral({ monaco, cls, range, projectPath, importContext, insertImportCommandId }) {
  const needsImport = !importContext.imported.has(cls.fqcn)

  return {
    label: {
      label: cls.shortName,
      description: cls.namespace,
    },
    kind: monaco.languages.CompletionItemKind.Class,
    detail: cls.namespace || '\\',
    documentation: relPath(cls.file, projectPath),
    insertText: cls.shortName,
    range,
    sortText: makeSortText(bucketFor(cls, importContext.prefix), cls.fqcn),
    filterText: cls.shortName,
    command: needsImport && insertImportCommandId
      ? { id: insertImportCommandId, title: 'Insert use', arguments: [cls.fqcn] }
      : undefined,
  }
}

/**
 * `use` context: insertion is the full FQCN, no additional edits needed.
 */
function buildItemUse({ monaco, cls, range, prefix, projectPath }) {
  return {
    label: {
      label: cls.fqcn,
      description: cls.source,
    },
    kind: monaco.languages.CompletionItemKind.Class,
    detail: cls.namespace || '\\',
    documentation: relPath(cls.file, projectPath),
    insertText: cls.fqcn,
    range,
    sortText: makeSortText(bucketFor(cls, prefix), cls.fqcn),
    filterText: cls.fqcn,
  }
}

/**
 * Insert `use FQCN;` into the editor's model.
 *
 * Runs as a post-completion command so it executes AFTER the cursor edit is
 * applied — no risk of range overlap. Idempotent: re-parses the buffer and
 * skips insertion if the import is already present.
 */
export function insertUseStatement(editor, monaco, fqcn) {
  if (!editor || !fqcn) return
  const model = editor.getModel()
  if (!model) return

  const { imported, lastUseLine, phpOpenLine } = parseImports(model)
  if (imported.has(fqcn)) return

  // True when the line at `lineNumber` exists and is blank — used to avoid
  // stacking multiple blank lines if the buffer already has one in place.
  const isBlankLine = (lineNumber) =>
    lineNumber <= model.getLineCount() && model.getLineContent(lineNumber).trim() === ''

  let range
  let text
  if (lastUseLine > 0) {
    // Append after the last existing use, on its own line. Ensure a blank
    // line separates the import block from the code that follows.
    const col = model.getLineMaxColumn(lastUseLine)
    range = new monaco.Range(lastUseLine, col, lastUseLine, col)
    text = isBlankLine(lastUseLine + 1) ? `\nuse ${fqcn};` : `\nuse ${fqcn};\n`
  } else if (phpOpenLine > 0) {
    // No existing imports, but a `<?php` opener exists — insert right below
    // it with a blank line separating the use from the code.
    const col = model.getLineMaxColumn(phpOpenLine)
    range = new monaco.Range(phpOpenLine, col, phpOpenLine, col)
    text = isBlankLine(phpOpenLine + 1) ? `\nuse ${fqcn};\n` : `\nuse ${fqcn};\n\n`
  } else {
    // No `<?php`, no existing imports — prepend at the very top of the file
    // so the use sits ABOVE the user's code, not below it.
    range = new monaco.Range(1, 1, 1, 1)
    text = isBlankLine(1) ? `use ${fqcn};\n` : `use ${fqcn};\n\n`
  }

  editor.executeEdits('phptinker-insert-use', [
    { range, text, forceMoveMarkers: false },
  ])
}

function relPath(absFile, projectPath) {
  if (!absFile) return ''
  if (projectPath && absFile.startsWith(projectPath + '/')) {
    return 'From: ' + absFile.slice(projectPath.length + 1)
  }
  return 'From: ' + absFile
}

/**
 * Create a Monaco completion provider object.
 *
 * @param {object} monaco
 * @param {() => {classes: Array, projectPath: string} | null} getCacheRef
 *        Returns the latest scan result + project path. Called fresh on
 *        every completion request — no internal caching.
 */
export function createClassCompletionProvider(monaco, getCacheRef, insertImportCommandId = null) {
  return {
    triggerCharacters: ['\\'],

    provideCompletionItems(model, position) {
      const cache = getCacheRef()
      if (!cache || !cache.classes?.length) return { suggestions: [] }

      const lineContent = model.getLineContent(position.lineNumber)
      const lineUpToCursor = lineContent.slice(0, position.column - 1)
      const ctx = readContext(lineUpToCursor)

      // Build the replacement range from the prefix start to the cursor.
      const startCol = position.column - ctx.prefix.length
      const range = new monaco.Range(
        position.lineNumber,
        startCol,
        position.lineNumber,
        position.column
      )

      const filtered = filterClasses(cache.classes, ctx)

      // Sort with our ranking, then slice — keeps Monaco's payload small.
      const ranked = filtered
        .map((c) => ({
          c,
          sort: makeSortText(bucketFor(c, ctx.prefix), c.fqcn),
        }))
        .sort((a, b) => (a.sort < b.sort ? -1 : a.sort > b.sort ? 1 : 0))
        .slice(0, MAX_RESULTS)
        .map((x) => x.c)

      const importContext =
        ctx.kind === 'general'
          ? { ...parseImports(model), prefix: ctx.prefix }
          : null

      const suggestions = ranked.map((cls) => {
        if (ctx.kind === 'use') {
          return buildItemUse({
            monaco,
            cls,
            range,
            prefix: ctx.prefix,
            projectPath: cache.projectPath,
          })
        }
        return buildItemGeneral({
          monaco,
          cls,
          range,
          projectPath: cache.projectPath,
          importContext,
          insertImportCommandId,
        })
      })

      return { suggestions, incomplete: filtered.length > MAX_RESULTS }
    },
  }
}
