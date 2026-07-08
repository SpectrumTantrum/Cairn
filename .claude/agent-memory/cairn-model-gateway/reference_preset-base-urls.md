---
name: preset-base-urls
description: How the BYOK provider preset base URLs were verified; re-check before trusting (they drift)
metadata:
  type: reference
---

The 15 provider preset base URLs in `PROVIDER_PRESETS` (`packages/engine/src/cloud-provider.ts`) were verified 2026-07-08 by probing each `{base}/models` endpoint with curl (no key):
- `401`/`403` = endpoint exists, needs auth = VALID (OpenAI, Mistral, xAI, DeepSeek, Cohere, Groq, Together, Fireworks, Cerebras, Anthropic).
- `200` = public list = valid (OpenRouter, DeepInfra, HuggingFace router).
- Gemini OpenAI-compat is special: `{base}/models` returns 404 unauthenticated (Google routes on the key), but `POST {base}/chat/completions` returns 400 = the endpoint is valid. Base = `https://generativelanguage.googleapis.com/v1beta/openai`.

Azure and Bedrock have NO fixed base URL (Azure = per-resource endpoint; Bedrock = per-region `bedrock-runtime.{region}.amazonaws.com`, derived from region).

**Why this matters:** provider base URLs drift. Before trusting a preset for real traffic, re-probe rather than assuming the shipped value is current. `aws4fetch` was confirmed MIT + zero deps via `npm view` the same day.
