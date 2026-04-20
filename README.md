# Omni Symbol Nav

An [Omni Code](https://github.com/GraysonBannister/omni-code) add-on that provides token-efficient code navigation using ripgrep. Instead of reading entire files, the agent can look up specific symbols and get back only the relevant lines.

Inspired by [Token Savior](https://github.com/mibayy/token-savior) and [code-review-graph](https://github.com/tirth8205/code-review-graph).

**Estimated savings: ~80–97% on code navigation tasks**

## Tools

### `find_symbol`

Find the definition of a function, class, method, or type by name across the workspace.

```
find_symbol("sendMessage")
find_symbol("UserService", directory: "src/services")
find_symbol("handleError", context_lines: 10)
```

Returns the file path, line number, and surrounding context. Uses 24 language-specific regex patterns covering TypeScript, JavaScript, Python, Go, Rust, Dart, Ruby, Java, and Kotlin.

**~50–200 tokens per lookup vs. thousands for a full file read.**

### `list_file_symbols`

Outline all top-level functions, classes, interfaces, and types in a file — without reading the full source.

```
list_file_symbols("src/core/agent.ts")
```

Returns a compact structural outline (line number + declaration). Great for understanding a file's API before deciding which parts to read.

### `find_references`

Find all usages / call sites of a symbol across the workspace.

```
find_references("sendMessage")
find_references("UserService", max_results: 100)
```

Returns file paths, line numbers, and the matching lines. Use this to understand the blast radius of a change without reading entire files.

## Requirements

- Omni Code v2.0.0 or later
- `rg` (ripgrep) — available on PATH or set `RG_PATH` env var. Ships with VS Code, Cursor, and most developer machines. Install via `brew install ripgrep`, `apt install ripgrep`, or [ripgrep releases](https://github.com/BurntSushi/ripgrep/releases).

## Installation

Install via the Omni Code Add-ons panel or directly from the [registry](https://graysonbannister.github.io/omni-code-website/addons).

## License

MIT
