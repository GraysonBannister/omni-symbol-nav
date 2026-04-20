/**
 * omni-symbol-nav — Token-Efficient Code Navigation via ripgrep
 *
 * Registers three tools that let the agent look up specific symbols instead of
 * reading entire files. A single find_symbol call returns ~50–200 tokens of
 * pinpointed context vs. thousands for a full file read.
 *
 * Tools:
 *   find_symbol       — find the definition of a function/class/method by name
 *   list_file_symbols — outline all top-level symbols in a file
 *   find_references   — find all call sites / usages of a symbol
 *
 * No external dependencies beyond ripgrep (rg), which ships with every major
 * IDE and most developer machines. Falls back gracefully if rg is unavailable.
 *
 * Works with all LLM providers. Inspired by Token Savior and code-review-graph.
 * Typical savings: 80–97% on code navigation tasks.
 */

'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// ---------------------------------------------------------------------------
// Ripgrep helpers
// ---------------------------------------------------------------------------

/** Resolve the ripgrep binary: prefer bundled rg, fall back to PATH. */
function getRgBin() {
  // Common locations where rg might be bundled (e.g. VS Code / Electron apps)
  const candidates = [
    process.env.RG_PATH,
    path.join(__dirname, '..', '..', '..', 'node_modules', '@vscode', 'ripgrep', 'bin', 'rg'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return 'rg'; // rely on PATH
}

const RG_BIN = getRgBin();

/**
 * Run ripgrep and return stdout as a string.
 * Returns null if rg is not found or the command fails fatally.
 */
function rg(args, cwd) {
  const result = spawnSync(RG_BIN, args, {
    cwd: cwd || process.cwd(),
    encoding: 'utf-8',
    maxBuffer: 4 * 1024 * 1024, // 4 MB
    timeout: 15000,
  });

  if (result.error) {
    if (result.error.code === 'ENOENT') return null; // rg not found
    throw result.error;
  }

  // Exit code 1 = no matches (not an error), 2 = real error
  if (result.status === 2) {
    throw new Error(`ripgrep error: ${result.stderr || 'unknown error'}`);
  }

  return result.stdout || '';
}

// ---------------------------------------------------------------------------
// Language-specific definition patterns
// ---------------------------------------------------------------------------

/**
 * Returns a list of ripgrep regex patterns that match the *definition* of
 * `symbolName` across common languages.
 */
function definitionPatterns(symbolName) {
  const s = symbolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // escape for regex
  return [
    // TypeScript / JavaScript
    `^(export\\s+)?(async\\s+)?function\\s+${s}\\s*[(<]`,
    `^(export\\s+)?const\\s+${s}\\s*=\\s*(async\\s+)?\\(`,
    `^(export\\s+)?(abstract\\s+)?class\\s+${s}[\\s{<(]`,
    `^(export\\s+)?interface\\s+${s}[\\s{<]`,
    `^(export\\s+)?type\\s+${s}\\s*=`,
    `^(export\\s+)?enum\\s+${s}[\\s{]`,
    `\\b(public|private|protected|static|async)?\\s+${s}\\s*\\(`, // class method
    // Python
    `^def\\s+${s}\\s*\\(`,
    `^class\\s+${s}[:(\\s]`,
    `^async\\s+def\\s+${s}\\s*\\(`,
    // Go
    `^func\\s+(\\(\\w+\\s+\\*?\\w+\\)\\s+)?${s}\\s*\\(`,
    `^type\\s+${s}\\s+(struct|interface)`,
    // Rust
    `^(pub\\s+)?(async\\s+)?fn\\s+${s}\\s*[<(]`,
    `^(pub\\s+)?struct\\s+${s}[\\s{<]`,
    `^(pub\\s+)?trait\\s+${s}[\\s{<]`,
    `^(pub\\s+)?enum\\s+${s}[\\s{<]`,
    // Dart / Flutter
    `^(Future|void|\\w+)\\s+${s}\\s*\\(`,
    `^class\\s+${s}\\s`,
    // Ruby
    `^\\s*def\\s+${s}`,
    `^\\s*class\\s+${s}`,
    // Java / Kotlin
    `(public|private|protected|static|\\s)\\s+\\S+\\s+${s}\\s*\\(`,
    `^(data\\s+)?class\\s+${s}[\\s({<:]`,
    `^(object|interface)\\s+${s}[\\s{<]`,
  ];
}

/**
 * Patterns that capture all top-level symbol declarations in a file.
 * Ordered so the most common come first.
 */
const ALL_SYMBOLS_PATTERN = [
  // TypeScript / JavaScript exports and declarations
  '^(export\\s+)?(default\\s+)?(async\\s+)?function\\s+(\\w+)',
  '^(export\\s+)?const\\s+(\\w+)\\s*=\\s*(async\\s+)?\\(',
  '^(export\\s+)?(abstract\\s+)?class\\s+(\\w+)',
  '^(export\\s+)?interface\\s+(\\w+)',
  '^(export\\s+)?type\\s+(\\w+)\\s*=',
  '^(export\\s+)?enum\\s+(\\w+)',
  // Python
  '^(async\\s+)?def\\s+(\\w+)\\s*\\(',
  '^class\\s+(\\w+)',
  // Go
  '^func\\s+(\\(\\w+\\s+\\*?\\w+\\)\\s+)?(\\w+)\\s*\\(',
  '^type\\s+(\\w+)\\s+(struct|interface)',
  // Rust
  '^(pub\\s+)?(async\\s+)?fn\\s+(\\w+)',
  '^(pub\\s+)?(struct|trait|enum|impl)\\s+(\\w+)',
  // Dart
  '^(Future<[^>]+>|void|\\w+)\\?? (\\w+)\\(',
  '^class\\s+(\\w+)',
  // Ruby
  '^\\s*(def|class|module)\\s+(\\w+)',
  // Java / Kotlin
  '^(data\\s+)?(class|interface|object|fun|enum)\\s+(\\w+)',
].join('|');

// ---------------------------------------------------------------------------
// Context extraction — fetch N lines around a match
// ---------------------------------------------------------------------------

/**
 * Given a file and a 1-based line number, return `contextLines` lines
 * before and after the match (inclusive).
 */
function extractContext(filePath, lineNum, contextLines) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    const start = Math.max(0, lineNum - contextLines - 1);
    const end = Math.min(lines.length, lineNum + contextLines);
    return lines
      .slice(start, end)
      .map((l, i) => `${start + i + 1}|${l}`)
      .join('\n');
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Tool: find_symbol
// ---------------------------------------------------------------------------

const findSymbolTool = {
  name: 'find_symbol',
  description:
    'Find the definition of a function, class, method, or type by name across the workspace. ' +
    'Returns the file path, line number, and a few lines of context around the definition. ' +
    'Use this instead of reading entire files when you need to locate a specific symbol. ' +
    'Token-efficient: returns ~50–200 tokens vs. thousands for a full file read.',
  inputSchema: {
    type: 'object',
    properties: {
      symbol: {
        type: 'string',
        description: 'The exact name of the function, class, method, or type to find.',
      },
      directory: {
        type: 'string',
        description:
          'Directory to search in. Defaults to the current working directory. ' +
          'Can be an absolute path or a path relative to the working directory.',
      },
      context_lines: {
        type: 'number',
        description: 'Lines of context to show around each match (default: 5, max: 20).',
      },
    },
    required: ['symbol'],
  },
  validate(input) {
    if (!input.symbol || typeof input.symbol !== 'string') {
      return 'symbol is required and must be a string';
    }
    return null;
  },
  async execute(input, context) {
    const symbol = String(input.symbol).trim();
    const searchDir = input.directory
      ? path.resolve(context.cwd, String(input.directory))
      : context.cwd;
    const ctxLines = Math.min(20, Math.max(0, Number(input.context_lines) || 5));

    const patterns = definitionPatterns(symbol);
    const rgArgs = [
      '--no-heading',
      '--line-number',
      '--max-count', '20',
      '--max-depth', '10',
      '--glob', '!node_modules',
      '--glob', '!.git',
      '--glob', '!dist',
      '--glob', '!build',
      '--glob', '!*.min.js',
      '-e', patterns.join('|'),
      searchDir,
    ];

    let output;
    try {
      output = rg(rgArgs, context.cwd);
    } catch (err) {
      return { content: `find_symbol error: ${err.message}`, isError: true };
    }

    if (output === null) {
      return {
        content: 'ripgrep (rg) not found. Install ripgrep to use omni-symbol-nav.',
        isError: true,
      };
    }

    if (!output.trim()) {
      return { content: `No definition found for "${symbol}" in ${searchDir}` };
    }

    // Parse rg output: "filepath:linenum:content"
    const matches = [];
    for (const line of output.trim().split('\n')) {
      const m = line.match(/^([^:]+):(\d+):(.*)$/);
      if (!m) continue;
      const [, file, lineNumStr, matchLine] = m;
      const lineNum = parseInt(lineNumStr, 10);
      const ctx = extractContext(file, lineNum, ctxLines);
      matches.push(`## ${file}:${lineNum}\n${ctx || matchLine}`);
      if (matches.length >= 10) break; // cap at 10 definitions
    }

    return {
      content: `Definitions of "${symbol}":\n\n${matches.join('\n\n')}`,
    };
  },
};

// ---------------------------------------------------------------------------
// Tool: list_file_symbols
// ---------------------------------------------------------------------------

const listFileSymbolsTool = {
  name: 'list_file_symbols',
  description:
    'List all top-level functions, classes, interfaces, types, and methods defined in a file. ' +
    'Returns a compact structural outline without full source code. ' +
    'Use this instead of reading an entire file when you only need to understand its structure. ' +
    'Token-efficient: returns ~100–500 tokens vs. thousands for a full file read.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Path to the file to outline. Absolute or relative to the working directory.',
      },
    },
    required: ['file_path'],
  },
  validate(input) {
    if (!input.file_path || typeof input.file_path !== 'string') {
      return 'file_path is required and must be a string';
    }
    return null;
  },
  async execute(input, context) {
    const filePath = path.isAbsolute(String(input.file_path))
      ? String(input.file_path)
      : path.resolve(context.cwd, String(input.file_path));

    const rgArgs = [
      '--no-heading',
      '--line-number',
      '--no-filename',
      '-e', ALL_SYMBOLS_PATTERN,
      filePath,
    ];

    let output;
    try {
      output = rg(rgArgs, context.cwd);
    } catch (err) {
      return { content: `list_file_symbols error: ${err.message}`, isError: true };
    }

    if (output === null) {
      return {
        content: 'ripgrep (rg) not found. Install ripgrep to use omni-symbol-nav.',
        isError: true,
      };
    }

    if (!output.trim()) {
      return { content: `No top-level symbols found in ${filePath}` };
    }

    const lines = output
      .trim()
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean);

    return {
      content: `Symbols in ${filePath} (${lines.length} found):\n\n${lines.join('\n')}`,
    };
  },
};

// ---------------------------------------------------------------------------
// Tool: find_references
// ---------------------------------------------------------------------------

const findReferencesTool = {
  name: 'find_references',
  description:
    'Find all usages / call sites of a function, class, or variable by name across the workspace. ' +
    'Returns file paths, line numbers, and the matching lines. ' +
    'Use this to understand the blast radius of a change without reading entire files. ' +
    'Token-efficient: returns only the relevant lines, not full file contents.',
  inputSchema: {
    type: 'object',
    properties: {
      symbol: {
        type: 'string',
        description: 'The exact name of the symbol to find references for.',
      },
      directory: {
        type: 'string',
        description:
          'Directory to search in. Defaults to the current working directory.',
      },
      max_results: {
        type: 'number',
        description: 'Maximum number of references to return (default: 50, max: 200).',
      },
    },
    required: ['symbol'],
  },
  validate(input) {
    if (!input.symbol || typeof input.symbol !== 'string') {
      return 'symbol is required and must be a string';
    }
    return null;
  },
  async execute(input, context) {
    const symbol = String(input.symbol).trim();
    const searchDir = input.directory
      ? path.resolve(context.cwd, String(input.directory))
      : context.cwd;
    const maxResults = Math.min(200, Math.max(1, Number(input.max_results) || 50));
    const s = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // Match any occurrence of the symbol as a whole word
    const rgArgs = [
      '--no-heading',
      '--line-number',
      '--max-count', String(maxResults),
      '--word-regexp',
      '--glob', '!node_modules',
      '--glob', '!.git',
      '--glob', '!dist',
      '--glob', '!build',
      '--glob', '!*.min.js',
      s,
      searchDir,
    ];

    let output;
    try {
      output = rg(rgArgs, context.cwd);
    } catch (err) {
      return { content: `find_references error: ${err.message}`, isError: true };
    }

    if (output === null) {
      return {
        content: 'ripgrep (rg) not found. Install ripgrep to use omni-symbol-nav.',
        isError: true,
      };
    }

    if (!output.trim()) {
      return { content: `No references found for "${symbol}" in ${searchDir}` };
    }

    const lines = output.trim().split('\n');
    const total = lines.length;
    const shown = lines.slice(0, maxResults);

    const suffix = total > maxResults
      ? `\n\n(${total - maxResults} more results not shown — reduce scope or increase max_results)`
      : '';

    return {
      content: `References to "${symbol}" (${Math.min(total, maxResults)} shown):\n\n${shown.join('\n')}${suffix}`,
    };
  },
};

// ---------------------------------------------------------------------------
// Addon lifecycle
// ---------------------------------------------------------------------------

/** @param {import('@omni-code/addon-api').AddonContext} context */
function activate(context) {
  context.registerTool(findSymbolTool);
  context.registerTool(listFileSymbolsTool);
  context.registerTool(findReferencesTool);
}

function deactivate() {
  // Tools are unregistered automatically on reload.
}

module.exports = { activate, deactivate };
