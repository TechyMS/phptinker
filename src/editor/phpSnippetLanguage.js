/**
 * Monaco language registration for "php-snippet" — bare PHP without an opening
 * `<?php` tag, the way phptinker buffers are written.
 *
 * Monaco's built-in `php` language starts in HTML mode and only switches to
 * PHP tokenization after seeing `<?php`. That makes a buffer like
 * `$x = 1; echo $x;` render as plain text. We register a parallel language
 * whose root state is the PHP tokenizer directly, lifted from monaco's own
 * source so keyword/string/number coloring matches the rest of the editor.
 */

const phpKeywords = [
  'abstract', 'and', 'array', 'as', 'break', 'callable', 'case', 'catch',
  'cfunction', 'class', 'clone', 'const', 'continue', 'declare', 'default',
  'do', 'else', 'elseif', 'enddeclare', 'endfor', 'endforeach', 'endif',
  'endswitch', 'endwhile', 'extends', 'false', 'final', 'for', 'foreach',
  'function', 'global', 'goto', 'if', 'implements', 'interface', 'instanceof',
  'insteadof', 'namespace', 'new', 'null', 'object', 'old_function', 'or',
  'private', 'protected', 'public', 'resource', 'static', 'switch', 'throw',
  'trait', 'try', 'true', 'use', 'var', 'while', 'xor', 'die', 'echo', 'empty',
  'exit', 'eval', 'include', 'include_once', 'isset', 'list', 'require',
  'require_once', 'return', 'print', 'unset', 'yield', '__construct',
  'fn', 'match', 'readonly', 'enum', 'self', 'parent', 'mixed', 'never',
  'string', 'int', 'float', 'bool', 'void',
]

const phpCompileTimeConstants = [
  '__CLASS__', '__DIR__', '__FILE__', '__LINE__', '__NAMESPACE__',
  '__METHOD__', '__FUNCTION__', '__TRAIT__',
]

const phpPreDefinedVariables = [
  '$GLOBALS', '$_SERVER', '$_GET', '$_POST', '$_FILES', '$_REQUEST',
  '$_SESSION', '$_ENV', '$_COOKIE', '$php_errormsg', '$HTTP_RAW_POST_DATA',
  '$http_response_header', '$argc', '$argv',
]

const conf = {
  wordPattern: /(-?\d*\.\d\w*)|([^\`\~\!\@\#\%\^\&\*\(\)\-\=\+\[\{\]\}\\\|\;\:\'\"\,\.\<\>\/\?\s]+)/g,
  comments: { lineComment: '//', blockComment: ['/*', '*/'] },
  brackets: [['{', '}'], ['[', ']'], ['(', ')']],
  autoClosingPairs: [
    { open: '{', close: '}', notIn: ['string'] },
    { open: '[', close: ']', notIn: ['string'] },
    { open: '(', close: ')', notIn: ['string'] },
    { open: '"', close: '"', notIn: ['string'] },
    { open: "'", close: "'", notIn: ['string', 'comment'] },
  ],
}

const language = {
  defaultToken: '',
  tokenPostfix: '.php',
  phpKeywords,
  phpCompileTimeConstants,
  phpPreDefinedVariables,
  escapes: /\\(?:[abfnrtv\\"']|x[0-9A-Fa-f]{1,4}|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8})/,

  tokenizer: {
    root: [
      [/[$][a-zA-Z_]\w*/, {
        cases: {
          '@phpPreDefinedVariables': { token: 'variable.predefined.php' },
          '@default': 'variable.php',
        },
      }],
      // Member access — the next identifier is a method or property.
      [/->/, { token: 'delimiter.php', next: '@phpMember' }],
      [/::/, { token: 'delimiter.php', next: '@phpStatic' }],
      // PascalCase identifiers → class/type names. Must come before the
      // general identifier rule so it wins the match.
      [/[A-Z][a-zA-Z0-9_]*(?=\s*\()/, 'type.function.php'],
      [/[A-Z][a-zA-Z0-9_]*/, 'type.php'],
      // Function call: lowercase identifier directly followed by `(`.
      [/[a-z_][\w]*(?=\s*\()/, {
        cases: {
          '@phpKeywords': { token: 'keyword.php' },
          '@default': 'function.php',
        },
      }],
      [/[a-zA-Z_]\w*/, {
        cases: {
          '@phpKeywords': { token: 'keyword.php' },
          '@phpCompileTimeConstants': { token: 'constant.php' },
          '@default': 'identifier.php',
        },
      }],
      // Namespace separator chains like Foo\Bar\Baz — already covered by
      // PascalCase per-segment, just color the backslash neutrally.
      [/\\/, 'delimiter.php'],
      [/[{}]/, 'delimiter.bracket.php'],
      [/[\[\]]/, 'delimiter.array.php'],
      [/[()]/, 'delimiter.parenthesis.php'],
      [/[ \t\r\n]+/, ''],
      [/\/\*/, 'comment.php', '@phpComment'],
      [/(#|\/\/)$/, 'comment.php'],
      [/(#|\/\/)/, 'comment.php', '@phpLineComment'],
      [/"/, 'string.php', '@phpDoubleQuoteString'],
      [/'/, 'string.php', '@phpSingleQuoteString'],
      [/[+\-*%&|^~!=<>?;:.,@]/, 'delimiter.php'],
      [/\//, 'delimiter.php'],
      [/\d+[eE]([\-+]?\d+)?/, 'number.float.php'],
      [/\d*\.\d+([eE][\-+]?\d+)?/, 'number.float.php'],
      [/0[xX][0-9a-fA-F']*[0-9a-fA-F]/, 'number.hex.php'],
      [/0[0-7']*[0-7]/, 'number.octal.php'],
      [/0[bB][0-1']*[0-1]/, 'number.binary.php'],
      [/\d[\d']*/, 'number.php'],
      [/\d/, 'number.php'],
    ],
    phpMember: [
      [/[a-zA-Z_]\w*(?=\s*\()/, 'method.php', '@pop'],
      [/[a-zA-Z_]\w*/, 'property.php', '@pop'],
      [/[ \t]+/, ''],
      [/./, { token: '@rematch', next: '@pop' }],
    ],
    phpStatic: [
      [/class\b/, 'keyword.php', '@pop'],
      [/[A-Z_][A-Z0-9_]+(?![a-z])/, 'constant.php', '@pop'],
      [/[a-zA-Z_]\w*(?=\s*\()/, 'method.php', '@pop'],
      [/[a-zA-Z_]\w*/, 'constant.php', '@pop'],
      [/[ \t]+/, ''],
      [/./, { token: '@rematch', next: '@pop' }],
    ],
    phpComment: [
      [/\*\//, 'comment.php', '@pop'],
      [/[^*]+/, 'comment.php'],
      [/./, 'comment.php'],
    ],
    phpLineComment: [
      [/.$/, 'comment.php', '@pop'],
      [/[^?]+$/, 'comment.php', '@pop'],
      [/[^?]+/, 'comment.php'],
      [/./, 'comment.php'],
    ],
    phpDoubleQuoteString: [
      [/[^\\"$]+/, 'string.php'],
      [/[$][a-zA-Z_]\w*/, 'variable.php'],
      [/@escapes/, 'string.escape.php'],
      [/\\./, 'string.escape.invalid.php'],
      [/"/, 'string.php', '@pop'],
    ],
    phpSingleQuoteString: [
      [/[^\\']+/, 'string.php'],
      [/@escapes/, 'string.escape.php'],
      [/\\./, 'string.escape.invalid.php'],
      [/'/, 'string.php', '@pop'],
    ],
  },
}

let registered = false
export function registerPhpSnippetLanguage(monaco) {
  if (registered) return
  registered = true
  monaco.languages.register({ id: 'php-snippet', extensions: [], aliases: ['PHP Snippet'] })
  monaco.languages.setLanguageConfiguration('php-snippet', conf)
  monaco.languages.setMonarchTokensProvider('php-snippet', language)
}
