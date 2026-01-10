# PROJECT KNOWLEDGE BASE

**Generated:** 2026-01-10
**Type:** Obsidian Plugin (TypeScript + CodeMirror 6)

## OVERVIEW
Obsidian plugin providing low-latency, inline AI autocomplete ("ghost text") via local Ollama models.
Prioritizes speed, privacy (local-only), and seamless editor integration.

## STRUCTURE
```
.
├── src/
│   └── main.ts         # MONOLITHIC ENTRY: All logic (Settings, API, CM6 State, UI)
├── styles.css          # Ghost text styling (.ollama-ghost-text)
├── Modelfile           # Critical: Ollama model config (latency tuning)
├── esbuild.config.mjs  # Build script (externalizes obsidian, @codemirror/*)
└── manifest.json       # Plugin metadata
```

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| **Core Logic** | `src/main.ts` | 700+ lines. Handles loading, API, and Editor Extensions. |
| **State** | `src/main.ts` | Look for `suggestionField` and `setSuggestionEffect`. |
| **Rendering** | `src/main.ts` | `GhostTextWidget` class & `suggestionDecorations`. |
| **API Calls** | `src/main.ts` | `fetchSuggestion()` function. Uses `AbortController`. |
| **Settings** | `src/main.ts` | `SmartComposeSettingTab` class. |
| **Model Tuning**| `Modelfile` | Defines `num_predict`, `temperature`, `stop` tokens. |

## CODE MAP
| Symbol | Type | Role |
|--------|------|------|
| `SmartComposePlugin` | Class | Main entry. `onload()` registers extensions. |
| `suggestionField` | StateField | Holds current ghost text state (string \| null). |
| `GhostTextWidget` | WidgetType | DOM renderer for the suggestion (opacity: 0.5). |
| `fetchSuggestion` | Function | Async. Debounced calls to Ollama `/api/generate`. |
| `handleAccept` | Command | Logic for Tab/Arrow acceptance (applies transaction). |

## CONVENTIONS
- **CM6 State**: NEVER manipulate DOM directly. Use `StateField` -> `Decoration` pipeline.
- **Latency First**:
    - Aggressive debouncing (250ms+).
    - `AbortController` on every new keystroke.
    - `raw: true` in Ollama API (no chat templates).
- **Model Context**:
    - Prepends file path & frontmatter as pseudo-YAML.
    - Limits context window to keep inference fast.

## ANTI-PATTERNS (THIS PROJECT)
- **Blocking**: NEVER block main thread.
- **Long Output**: NEVER allow multi-line generation (enforce `stop: ["\n"]`).
- **Chat APIs**: DO NOT use `/api/chat`. Use `/api/generate` for raw completion.
- **Dependencies**: AVOID adding runtime deps. Keep bundle small.
- **Testing**: No test suite exists. Verify manually by typing.

## COMMANDS
```bash
npm run dev    # Watch mode (esbuild)
npm run build  # Production bundle -> main.js
```
