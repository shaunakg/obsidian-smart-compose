# Smart Compose

Provide Gmail and Google Docs-like inline autocomplete using local language models.

## Features

- Inline ghost-text suggestions while typing
- Accept with Tab or Right Arrow
- Fast, local-only inference via Ollama

## Set up Ollama for inline autocomplete

This plugin uses a local Ollama model to generate short inline suggestions.

To keep suggestions fast, the plugin:

- Sends only a short prefix of text near your cursor.
- Uses Ollama `/api/generate` with `raw: true` to avoid chat formatting.
- Limits the number of generated tokens.

> [!info]+ Why this matters
> Inline autocomplete is latency-sensitive. Sending fewer tokens and generating fewer tokens reduces response time on most devices. Use the recommended defaults as a benchmark, then run your own tests to find the best settings for your hardware.

---

## Install Ollama

### Desktop

1. Download Ollama:
   - https://ollama.com/download

2. Install Ollama.

3. Open a terminal and verify the install:

```bash
ollama --version
```

4. Make sure Ollama is running.

> [!tip]- Keep Ollama running
> If Ollama is not running, the plugin cannot connect to `http://localhost:11434`.

### Mobile

This plugin requires a local Ollama server. Most mobile devices cannot run Ollama directly, so inline autocomplete may not work on mobile.

---

## Create an autocomplete model (recommended)

You can use `qwen3:0.6b` directly, but creating a dedicated model makes it easier to keep autocomplete settings consistent.

### Download the model definition

The `Modelfile` is the Ollama model definition that sets the base model, prompt template, and generation parameters. It keeps autocomplete output short and stable for low latency. If your device is slower or faster than the defaults, adjust the parameters to match your hardware and workflow.

This `Modelfile` uses `qwen3:0.6b` and applies these changes:

- **TEMPLATE "{{ .Prompt }}"** — uses the raw prompt without a chat wrapper.
- **SYSTEM /no_think** — disables think-style output for faster completion.
- **PARAMETER temperature 0.2, top_p 0.9, top_k 40, repeat_penalty 1.05** — stable, low-variance sampling.
- **PARAMETER num_ctx 4096** — sets the model context size.
- **PARAMETER num_predict 32** — caps output length.
- **PARAMETER stop "\\n"** — stops at a newline to avoid multi-line output.

1. Download `Modelfile` from the repo:

   - https://raw.githubusercontent.com/shaunakg/obsidian-smart-compose/main/Modelfile

2. Save it as `Modelfile` in the same folder where you run Ollama commands.

### Create the model

Run:

```bash
ollama create qwen-0.6b-autocomplete -f Modelfile
```

> [!info]+ Why these parameters
> - **TEMPLATE "{{ .Prompt }}"** — avoids chat formatting tokens and keeps the prompt small.
> - **temperature 0.2** — reduces randomness so suggestions follow your text.
> - **num_predict 16** — limits output length, which reduces latency.
> - **stop "\n"** — prevents the model from continuing into multiple lines.
>
> These defaults aim for low latency on typical laptops. If suggestions feel slow, reduce `num_predict` and the plugin’s context length. If suggestions feel too short or generic, increase `num_predict` or use a larger model.

---

## Configure the plugin

1. Open **[[Settings]] → Community plugins → Smart Compose**.

2. Set:
   - **Ollama URL** — `http://localhost:11434`
   - **Model** — `qwen-0.6b-autocomplete`

> [!tip]- Use a dedicated model name
> Using `qwen-0.6b-autocomplete` makes it clear which model is tuned for inline suggestions.

---

## Verify the model

### Confirm the model is available

Run:

```bash
ollama list
```

You should see `qwen-0.6b-autocomplete` in the list.

### Test a short completion

Run:

```bash
curl http://localhost:11434/api/generate -H "Content-Type: application/json" -d '{
  "model": "qwen-0.6b-autocomplete",
  "prompt": "I think the main reason this works is",
  "raw": true,
  "stream": false,
  "options": {
    "num_predict": 16,
    "stop": ["\n"]
  }
}'
```

> [!warning]+ Avoid long completions
> If you increase `num_predict` too much, the model may generate long text. Long outputs increase latency and can feel distracting in an inline autocomplete workflow.

---

## Customize for speed or quality

Use the defaults as a starting point, then test changes one at a time. Measure how long it takes from “stop typing” to “ghost text appears” in the Obsidian application.

### Change output length (recommended first)

Edit `PARAMETER num_predict` in your `Modelfile`, then recreate the model:

```bash
ollama create qwen-0.6b-autocomplete -f Modelfile
```

Suggested values:

- **8–12** — fastest, shortest suggestions
- **16** — default balance
- **24–32** — longer suggestions, higher latency

> [!info]+ Why this works
> Generation time increases with the number of output tokens. Keeping output short is one of the most effective ways to reduce latency.

### Change randomness

Suggested presets:

- **More stable**
  - `temperature 0.1`
  - `top_p 0.9`

- **Default**
  - `temperature 0.2`
  - `top_p 0.9`

- **More varied**
  - `temperature 0.35`
  - `top_p 0.95`

> [!info]+ Why this matters
> Autocomplete usually works best when it is conservative. High randomness can cause suggestions to change direction and feel less relevant.

### Reduce repetition

If you see repeated words, increase:

- `repeat_penalty 1.08` to `1.15`

If suggestions feel too constrained, decrease:

- `repeat_penalty 1.00` to `1.05`

---

## Troubleshoot

### Ollama is not reachable

- Confirm Ollama is running.
- Confirm the plugin uses `http://localhost:11434`.
- Run:

```bash
curl http://localhost:11434/api/tags
```

### Suggestions are slow

- Reduce the plugin “context characters” setting (if available).
- Reduce `num_predict` to `8` or `12`.
- Keep Ollama running to avoid cold starts.

### Suggestions are too long

- Reduce `num_predict`.
- Keep `PARAMETER stop "\n"` enabled.

## Settings

- Ollama URL
- Model name
- Context characters
- Debounce delay
- Max tokens
- Disable in code blocks
- Debug logging
