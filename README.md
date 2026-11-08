# `llm` — one command, local models in OpenCode

[![Ollama Cloud](https://img.shields.io/badge/Ollama-Cloud-supported-412991?style=for-the-badge&logo=ollama&logoColor=white)](https://ollama.com)
[![GitHub stars](https://img.shields.io/github/stars/rjcamandona123/opencode_v2-ollamacloud?style=for-the-badge)](https://github.com/rjcamandona123/opencode_v2-ollamacloud/stargazers)
[![GitHub forks](https://img.shields.io/github/forks/rjcamandona123/opencode_v2-ollamacloud?style=for-the-badge)](https://github.com/rjcamandona123/opencode_v2-ollamacloud/network/members)
[![GitHub issues](https://img.shields.io/github/issues/rjcamandona123/opencode_v2-ollamacloud?style=for-the-badge)](https://github.com/rjcamandona123/opencode_v2-ollamacloud/issues)
[![GitHub last commit](https://img.shields.io/github/last-commit/rjcamandona123/opencode_v2-ollamacloud?style=for-the-badge)](https://github.com/rjcamandona123/opencode_v2-ollamacloud/commits/main)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](./LICENSE)


```bash
./llm setup
```

That's it. It detects the machine, installs a backend, starts it, pulls one model,
writes the OpenCode provider config, allows all tools, and reloads OpenCode.

## What it picks

| Platform | Backend | Why |
|---|---|---|
| Linux (glibc), macOS | **Ollama** | official installer, zero config |
| Alpine / musl / Android | **llama.cpp** (built from source) | Ollama ships glibc-only binaries |
| Windows | **Ollama** via winget | native service |

Override with `LLM_MODEL` (Ollama tag) or `LLM_GGUF` (HF repo:quant).

## Commands

```bash
llm setup                # full auto setup
llm setup --default      # ...and make the local model the default
llm setup --no-model     # configure only, pull nothing
llm status               # environment + what is running
llm models               # models the backend serves
llm pull qwen3:8b        # add a model (Ollama)
llm start | stop         # control the backend
llm config               # regenerate OpenCode config from live models
```

## What it writes

`~/.config/opencode/opencode.jsonc` (or `$XDG_CONFIG_HOME/opencode/...`):

```jsonc
{
  "providers": {
    "ollama": { "settings": { "baseURL": "http://127.0.0.1:11434/v1" } }
  },
  "permissions": [{ "action": "*", "resource": "*", "effect": "allow" }],
  "policies":    [{ "action": "provider.use", "resource": "*", "effect": "allow" }]
}
```

- every write is backed up as `opencode.jsonc.bak-<timestamp>`
- existing keys, MCP servers, plugins, and permissions are preserved
- `permissions` catch-all is appended **last**, so it can be removed without
  touching the rules above it

## Defaults

| | Model | Size |
|---|---|---|
| Ollama | `qwen3:1.7b` | ~1.4 GB |
| llama.cpp | `unsloth/Qwen3-1.7B-GGUF:Q4_K_M` | ~1.1 GB |

Small on purpose: it runs on a phone-class CPU and leaves RAM for OpenCode.

## State

```text
~/.llm/server.pid     running process
~/.llm/server.log     backend output
~/.llm/llama.cpp/     source (only on musl builds)
~/.llm/build/bin/     llama-server, llama-cli
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| `llama-server did not start` | `tail ~/.llm/server.log` |
| Port busy | `llm stop`, or change `LLAMA_PORT` / `OLLAMA_PORT` in the script |
| No models in `/models` | `llm status`, then `llm models` |
| Slow generation | expected on CPU; use a smaller quant or Ollama Cloud |

## Cloud instead of local

Zero download, metered:

```jsonc
{
  "providers": {
    "ollama": {
      "settings": {
        "baseURL": "https://ollama.com/v1",
        "apiKey": "{env:OLLAMA_CLOUD_API_KEY}"
      }
    }
  }
}
```

Ollama is a built-in provider, so `https://ollama.com/v1` plus a key is all it needs —
OpenCode derives `/api/tags` discovery from the same base URL.

## Uninstall

```bash
llm stop
rm -rf ~/.llm
# then delete the providers.ollama / providers.llamacpp block from opencode.jsonc
```
