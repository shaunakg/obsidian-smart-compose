import { App, Plugin, PluginSettingTab, Setting } from "obsidian";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
  keymap
} from "@codemirror/view";
import { Prec, StateEffect, StateField, Text } from "@codemirror/state";

interface AutocompleteSettings {
  ollamaUrl: string;
  model: string;
  contextChars: number;
  debounceMs: number;
  maxTokens: number;
  disableInCodeBlocks: boolean;
  debugLogging: boolean;
}

const DEFAULT_SETTINGS: AutocompleteSettings = {
  ollamaUrl: "http://localhost:11434",
  model: "qwen3:0.6b",
  contextChars: 400,
  debounceMs: 250,
  maxTokens: 16,
  disableInCodeBlocks: true,
  debugLogging: false
};

const setSuggestionEffect = StateEffect.define<string | null>();

class GhostTextWidget extends WidgetType {
  private readonly text: string;

  constructor(text: string) {
    super();
    this.text = text;
  }

  eq(other: GhostTextWidget): boolean {
    return this.text === other.text;
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "ollama-ghost-text";
    span.textContent = this.text;
    return span;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

const suggestionField = StateField.define<string | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setSuggestionEffect)) {
        return effect.value;
      }
    }
    if (tr.docChanged || tr.selection) {
      return null;
    }
    return value;
  }
});

const suggestionDecorations = EditorView.decorations.compute(
  [suggestionField],
  state => {
    const suggestion = state.field(suggestionField);
    if (!suggestion) {
      return Decoration.none;
    }
    const pos = state.selection.main.head;
    const deco = Decoration.widget({
      widget: new GhostTextWidget(suggestion),
      side: 1
    });
    return Decoration.set([deco.range(pos)]);
  }
);

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function isWordChar(ch: string): boolean {
  if (!ch) {
    return false;
  }
  const code = ch.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95
  );
}

function isWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

function isPunctuationTrigger(ch: string): boolean {
  return ch === "." || ch === ",";
}

function isInFrontmatter(doc: Text, pos: number): boolean {
  if (doc.lines < 2) {
    return false;
  }
  const firstLine = doc.line(1).text.trim();
  if (firstLine !== "---") {
    return false;
  }
  const posLine = doc.lineAt(pos).number;
  for (let lineNo = 2; lineNo <= doc.lines; lineNo++) {
    const lineText = doc.line(lineNo).text.trim();
    if (lineText === "---") {
      return posLine <= lineNo;
    }
  }
  return true;
}

function isInFencedCodeBlock(doc: Text, pos: number): boolean {
  const posLine = doc.lineAt(pos).number;
  let inFence = false;
  for (let lineNo = 1; lineNo <= posLine; lineNo++) {
    const lineText = doc.line(lineNo).text.trim();
    if (lineText.startsWith("```") || lineText.startsWith("~~~")) {
      inFence = !inFence;
    }
  }
  return inFence;
}

function isInInlineCode(doc: Text, pos: number): boolean {
  const line = doc.lineAt(pos);
  const offset = pos - line.from;
  const before = line.text.slice(0, offset);
  let backticks = 0;
  for (let i = 0; i < before.length; i++) {
    if (before[i] === "`") {
      backticks++;
    }
  }
  return backticks % 2 === 1;
}

function buildOllamaUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/api/generate`;
}

function debugLog(
  settingsGetter: () => AutocompleteSettings,
  message: string,
  details?: Record<string, unknown>
): void {
  if (!settingsGetter().debugLogging) {
    return;
  }
  if (details) {
    console.debug("[Smart Compose]", message, details);
  } else {
    console.debug("[Smart Compose]", message);
  }
}

function createAutocompleteExtension(
  settingsGetter: () => AutocompleteSettings
) {
  const viewPlugin = ViewPlugin.fromClass(
    class {
      private view: EditorView;
      private requestAbort: AbortController | null;
      private requestId: number;
      private debounceHandle: number | null;
      private pendingClearHandle: number | null;
      private readonly keydownCapture: (event: KeyboardEvent) => void;
      private readonly windowKeydownCapture: (event: KeyboardEvent) => void;

      constructor(view: EditorView) {
        this.view = view;
        this.requestAbort = null;
        this.requestId = 0;
        this.debounceHandle = null;
        this.pendingClearHandle = null;
        this.keydownCapture = (event: KeyboardEvent) => {
          if (event.key !== "Tab" && event.key !== "ArrowRight" && event.key !== "Escape") {
            return;
          }
          debugLog(settingsGetter, "view keydown capture", { key: event.key });
          const suggestion = this.view.state.field(suggestionField);
          if (!suggestion) {
            debugLog(settingsGetter, "capture keydown - no suggestion", {
              key: event.key
            });
            return;
          }
          event.preventDefault();
          event.stopImmediatePropagation();
          if (event.key === "Escape") {
            debugLog(settingsGetter, "capture keydown dismiss");
            this.clearSuggestion();
            return;
          }
          debugLog(settingsGetter, "capture keydown accept", { key: event.key });
          const pos = this.view.state.selection.main.head;
          this.view.dispatch({
            changes: { from: pos, to: pos, insert: suggestion },
            selection: { anchor: pos + suggestion.length },
            effects: setSuggestionEffect.of(null)
          });
        };
        this.windowKeydownCapture = (event: KeyboardEvent) => {
          if (event.key !== "Tab" && event.key !== "ArrowRight" && event.key !== "Escape") {
            return;
          }
          const target = event.target;
          if (!(target instanceof Node)) {
            return;
          }
          const path = typeof event.composedPath === "function" ? event.composedPath() : [];
          const inEditor =
            this.view.dom.contains(target) ||
            this.view.contentDOM.contains(target) ||
            path.includes(this.view.dom) ||
            path.includes(this.view.contentDOM);
          if (!inEditor) {
            return;
          }
          debugLog(settingsGetter, "window keydown capture", { key: event.key });
          const suggestion = this.view.state.field(suggestionField);
          if (!suggestion) {
            debugLog(settingsGetter, "window capture - no suggestion", {
              key: event.key
            });
            return;
          }
          event.preventDefault();
          event.stopImmediatePropagation();
          if (event.key === "Escape") {
            debugLog(settingsGetter, "window capture dismiss");
            this.clearSuggestion();
            return;
          }
          debugLog(settingsGetter, "window capture accept", { key: event.key });
          const pos = this.view.state.selection.main.head;
          this.view.dispatch({
            changes: { from: pos, to: pos, insert: suggestion },
            selection: { anchor: pos + suggestion.length },
            effects: setSuggestionEffect.of(null)
          });
        };
        this.view.dom.addEventListener("keydown", this.keydownCapture, true);
        window.addEventListener("keydown", this.windowKeydownCapture, true);
      }

      update(update: ViewUpdate): void {
        if (update.focusChanged && !this.view.hasFocus) {
          debugLog(settingsGetter, "editor blur - clear");
          this.cancelAndClear(true);
          return;
        }

        if (update.selectionSet && !update.docChanged) {
          debugLog(settingsGetter, "selection moved - clear");
          this.cancelAndClear(true);
          return;
        }

        if (update.docChanged) {
          debugLog(settingsGetter, "doc changed - schedule");
          this.cancelAndClear(true);
          this.schedule();
        }
      }

      destroy(): void {
        this.cancelAndClear(false);
        this.view.dom.removeEventListener("keydown", this.keydownCapture, true);
        window.removeEventListener("keydown", this.windowKeydownCapture, true);
      }

      private schedule(): void {
        this.clearDebounce();
        const settings = settingsGetter();
        const delay = clamp(settings.debounceMs, 100, 500);
        debugLog(settingsGetter, "debounce scheduled", { delay });
        this.debounceHandle = window.setTimeout(() => {
          this.debounceHandle = null;
          void this.maybeRequest();
        }, delay);
      }

      private async maybeRequest(): Promise<void> {
        if (!this.view.hasFocus) {
          debugLog(settingsGetter, "skip request - no focus");
          return;
        }
        if (this.requestAbort) {
          debugLog(settingsGetter, "skip request - in flight");
          return;
        }
        if (!this.isCursorEligible()) {
          return;
        }
        const prefix = this.getPrefix();
        if (!prefix) {
          debugLog(settingsGetter, "skip request - prefix too short/empty");
          return;
        }
        debugLog(settingsGetter, "request start", { prefixChars: prefix.length });
        await this.sendRequest(prefix);
      }

      private isCursorEligible(): boolean {
        const state = this.view.state;
        const selection = state.selection.main;
        if (!selection.empty) {
          debugLog(settingsGetter, "cursor not eligible - non-empty selection");
          return false;
        }
        const pos = selection.head;
        if (pos === 0) {
          debugLog(settingsGetter, "cursor not eligible - start of doc");
          return false;
        }
        const prevChar = state.doc.sliceString(pos - 1, pos);
        if (prevChar === " ") {
          if (pos < 2) {
            debugLog(settingsGetter, "cursor not eligible - space at start");
            return false;
          }
          const prevPrev = state.doc.sliceString(pos - 2, pos - 1);
          if (isWhitespace(prevPrev)) {
            debugLog(settingsGetter, "cursor not eligible - double space");
            return false;
          }
        } else if (!isWordChar(prevChar) && !isPunctuationTrigger(prevChar)) {
          debugLog(settingsGetter, "cursor not eligible - not end of word");
          return false;
        }
        const nextChar = state.doc.sliceString(pos, pos + 1);
        if (nextChar && isWordChar(nextChar)) {
          debugLog(settingsGetter, "cursor not eligible - mid token");
          return false;
        }
        if (isInFrontmatter(state.doc, pos)) {
          debugLog(settingsGetter, "cursor not eligible - frontmatter");
          return false;
        }
        const settings = settingsGetter();
        if (settings.disableInCodeBlocks) {
          if (isInFencedCodeBlock(state.doc, pos)) {
            debugLog(settingsGetter, "cursor not eligible - fenced code");
            return false;
          }
          if (isInInlineCode(state.doc, pos)) {
            debugLog(settingsGetter, "cursor not eligible - inline code");
            return false;
          }
        }
        return true;
      }

      private getPrefix(): string | null {
        const state = this.view.state;
        const pos = state.selection.main.head;
        const settings = settingsGetter();
        const contextChars = clamp(settings.contextChars, 100, 800);
        const start = Math.max(0, pos - contextChars);
        const prefix = state.doc.sliceString(start, pos);
        if (prefix.length < 10) {
          return null;
        }
        if (prefix.trim().length === 0) {
          return null;
        }
        return prefix;
      }

      private async sendRequest(prefix: string): Promise<void> {
        const settings = settingsGetter();
        const url = buildOllamaUrl(settings.ollamaUrl);
        const requestId = ++this.requestId;
        const controller = new AbortController();
        this.requestAbort = controller;
        const timeoutId = window.setTimeout(() => controller.abort(), 1500);

        const body = {
          model: settings.model,
          prompt: prefix,
          raw: true,
          stream: false,
          options: {
            temperature: 0.2,
            top_p: 0.9,
            top_k: 40,
            repeat_penalty: 1.05,
            num_predict: clamp(settings.maxTokens, 8, 32),
            stop: ["\n"]
          }
        };

        try {
          const response = await fetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify(body),
            signal: controller.signal
          });

          if (requestId !== this.requestId) {
            debugLog(settingsGetter, "request stale - discard response");
            return;
          }

          if (!response.ok) {
            debugLog(settingsGetter, "request failed", { status: response.status });
            return;
          }

          const data = (await response.json()) as { response?: unknown };
          if (requestId !== this.requestId) {
            debugLog(settingsGetter, "request stale - discard body");
            return;
          }

          if (!data || typeof data.response !== "string") {
            debugLog(settingsGetter, "malformed response");
            return;
          }

          if (data.response.length === 0) {
            debugLog(settingsGetter, "empty suggestion");
            return;
          }

          debugLog(settingsGetter, "suggestion received", {
            chars: data.response.length
          });
          this.showSuggestion(data.response);
        } catch (error) {
          if (settings.debugLogging && error instanceof Error) {
            console.debug("[Smart Compose]", "request error", error.message);
          }
        } finally {
          window.clearTimeout(timeoutId);
          if (this.requestAbort === controller) {
            this.requestAbort = null;
          }
        }
      }

      private showSuggestion(text: string): void {
        if (!text) {
          return;
        }
        const pos = this.view.state.selection.main.head;
        const prevChar = pos > 0 ? this.view.state.doc.sliceString(pos - 1, pos) : "";
        let suggestion = text;
        if (prevChar === " " && suggestion.startsWith(" ")) {
          suggestion = suggestion.slice(1);
          debugLog(settingsGetter, "dedupe leading space");
        }
        if (!suggestion) {
          return;
        }
        debugLog(settingsGetter, "show suggestion");
        this.view.dispatch({
          effects: setSuggestionEffect.of(suggestion)
        });
      }

      private clearSuggestion(): void {
        if (!this.view.state.field(suggestionField)) {
          return;
        }
        debugLog(settingsGetter, "clear suggestion");
        this.view.dispatch({
          effects: setSuggestionEffect.of(null)
        });
      }

      private cancelRequest(): void {
        if (this.requestAbort) {
          debugLog(settingsGetter, "cancel request");
          this.requestAbort.abort();
          this.requestAbort = null;
        }
        this.requestId = 0;
      }

      private clearDebounce(): void {
        if (this.debounceHandle !== null) {
          debugLog(settingsGetter, "clear debounce");
          window.clearTimeout(this.debounceHandle);
          this.debounceHandle = null;
        }
      }

      private scheduleClearSuggestion(): void {
        if (this.pendingClearHandle !== null) {
          return;
        }
        this.pendingClearHandle = window.setTimeout(() => {
          this.pendingClearHandle = null;
          this.clearSuggestion();
        }, 0);
      }

      private cancelAndClear(deferClear: boolean): void {
        if (deferClear) {
          this.scheduleClearSuggestion();
        } else {
          this.clearSuggestion();
        }
        this.cancelRequest();
        this.clearDebounce();
      }
    }
  );

  const acceptSuggestion = (view: EditorView): boolean => {
    const suggestion = view.state.field(suggestionField);
    if (!suggestion) {
      return false;
    }
    const pos = view.state.selection.main.head;
    debugLog(settingsGetter, "accept suggestion", {
      chars: suggestion.length
    });
    view.dispatch({
      changes: { from: pos, to: pos, insert: suggestion },
      selection: { anchor: pos + suggestion.length },
      effects: setSuggestionEffect.of(null)
    });
    return true;
  };

  const clearSuggestion = (view: EditorView): boolean => {
    const suggestion = view.state.field(suggestionField);
    if (!suggestion) {
      return false;
    }
    debugLog(settingsGetter, "dismiss suggestion");
    view.dispatch({
      effects: setSuggestionEffect.of(null)
    });
    return true;
  };

  const domKeyHandler = EditorView.domEventHandlers({
    keydown: (event, view) => {
      if (event.key === "Tab" || event.key === "ArrowRight") {
        const suggestion = view.state.field(suggestionField);
        if (!suggestion) {
          debugLog(settingsGetter, "keydown ignored - no suggestion", {
            key: event.key
          });
          return false;
        }
        event.preventDefault();
        debugLog(settingsGetter, "keydown accept", { key: event.key });
        acceptSuggestion(view);
        return true;
      }
      if (event.key === "Escape") {
        const suggestion = view.state.field(suggestionField);
        if (!suggestion) {
          return false;
        }
        event.preventDefault();
        debugLog(settingsGetter, "keydown dismiss");
        clearSuggestion(view);
        return true;
      }
      return false;
    }
  });

  return [
    suggestionField,
    suggestionDecorations,
    viewPlugin,
    domKeyHandler,
    Prec.highest(
      keymap.of([
        {
          key: "Tab",
          run: acceptSuggestion
        },
        {
          key: "ArrowRight",
          run: acceptSuggestion
        },
        {
          key: "Escape",
          run: clearSuggestion
        }
      ])
    )
  ];
}

export default class InlineAutocompletePlugin extends Plugin {
  settings: AutocompleteSettings;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerEditorExtension(
      createAutocompleteExtension(() => this.settings)
    );

    this.addSettingTab(new InlineAutocompleteSettingTab(this.app, this));
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.settings.contextChars = clamp(this.settings.contextChars, 100, 800);
    this.settings.debounceMs = clamp(this.settings.debounceMs, 100, 500);
    this.settings.maxTokens = clamp(this.settings.maxTokens, 8, 32);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}

class InlineAutocompleteSettingTab extends PluginSettingTab {
  private plugin: InlineAutocompletePlugin;

  constructor(app: App, plugin: InlineAutocompletePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;

    containerEl.empty();

    new Setting(containerEl)
      .setName("Ollama URL")
      .setDesc("Local Ollama server URL.")
      .addText(text =>
        text
          .setPlaceholder("http://localhost:11434")
          .setValue(this.plugin.settings.ollamaUrl)
          .onChange(async value => {
            this.plugin.settings.ollamaUrl = value.trim() || DEFAULT_SETTINGS.ollamaUrl;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Model name")
      .setDesc("Ollama model name for raw continuation.")
      .addText(text =>
        text
          .setPlaceholder("qwen3:0.6b")
          .setValue(this.plugin.settings.model)
          .onChange(async value => {
            this.plugin.settings.model = value.trim() || DEFAULT_SETTINGS.model;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Context characters")
      .setDesc("Number of characters before the cursor (100-800).")
      .addText(text =>
        text
          .setPlaceholder("400")
          .setValue(String(this.plugin.settings.contextChars))
          .onChange(async value => {
            const parsed = Number.parseInt(value, 10);
            const next = Number.isNaN(parsed)
              ? DEFAULT_SETTINGS.contextChars
              : clamp(parsed, 100, 800);
            this.plugin.settings.contextChars = next;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Debounce delay (ms)")
      .setDesc("Typing pause before requesting (100-500).")
      .addText(text =>
        text
          .setPlaceholder("250")
          .setValue(String(this.plugin.settings.debounceMs))
          .onChange(async value => {
            const parsed = Number.parseInt(value, 10);
            const next = Number.isNaN(parsed)
              ? DEFAULT_SETTINGS.debounceMs
              : clamp(parsed, 100, 500);
            this.plugin.settings.debounceMs = next;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Max tokens")
      .setDesc("Maximum tokens to request (8-32).")
      .addText(text =>
        text
          .setPlaceholder("16")
          .setValue(String(this.plugin.settings.maxTokens))
          .onChange(async value => {
            const parsed = Number.parseInt(value, 10);
            const next = Number.isNaN(parsed)
              ? DEFAULT_SETTINGS.maxTokens
              : clamp(parsed, 8, 32);
            this.plugin.settings.maxTokens = next;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Disable in code blocks")
      .setDesc("Skip suggestions inside fenced/inline code blocks.")
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.disableInCodeBlocks)
          .onChange(async value => {
            this.plugin.settings.disableInCodeBlocks = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Debug logging")
      .setDesc("Increase logging verbosity for debugging.")
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.debugLogging)
          .onChange(async value => {
            this.plugin.settings.debugLogging = value;
            await this.plugin.saveSettings();
          })
      );
  }
}
