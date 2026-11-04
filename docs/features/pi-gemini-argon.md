# Gemini 4 Argon in Pi

更新：2026-11-03 · 阶段：已合入（流式改走 Pi 官方 Google provider）

实现已包含在当前源码中；已安装版本：未核对。

Select **Pi → Google AI → Gemini 4 Argon** in Settings → Model or the Composer.
Configure a paid Gemini API key from [Google AI Studio](https://aistudio.google.com/app/apikey)
in Settings, or supply `GEMINI_API_KEY` to the backend. API billing is separate
from the Gemini application's subscription. Existing explicit model choices
are retained; the Google provider's default for new selections is Argon.

The model ID is `gemini-4-argon`. Google and OpenRouter's
`google/gemini-4-argon` expose **Low / Medium / High**, with Medium as the
default. Unsupported legacy effort choices clamp to the nearest supported
level (Off/Minimal → Low, XHigh/Max → High). Google requests use
`thinkingLevel`, never the legacy `thinkingBudget`.

## Streaming and output

Argon streams through Pi's built-in Google provider (`@earendil-works/pi-ai`
1.5.0 and the `@google/genai` version it pins), like every other Gemini model.
Michi keeps only its own model definition, for the pricing change below.

Argon's context window is 1,048,576 tokens. One response is limited to Google's
per-request `outputTokenLimit` of **32,768 tokens**, thinking included; a longer
response ends with stop reason `length`. Pi does not implement Google's long-decode
continuation, so Michi no longer continues past that limit, and
`MICHI_GEMINI_ARGON_MAX_OUTPUT_TOKENS` no longer has an effect. A network failure
mid-response fails the turn; the user retries it.

History: from 2026-10-14 to 2026-11-03 a Michi adapter (`geminiArgonStream.ts`)
continued generation with continuation tokens up to 262,144 tokens and resumed
from provider checkpoints. After the Pi 1.4 session SDK moved the
system prompt and tools into transcript system messages, that adapter sent
neither, and Argon failed with `MALFORMED_FUNCTION_CALL` when it tried to call
Michi tools. Removing the adapter puts Argon on Pi's transcript handling.

## Usage and verification

Google introductory pricing through November 30, 2026 is $2 input, $10 output,
and $0.10 cached input per million tokens. Starting December 1 UTC, Michi's
model definition uses $4 / $20 / $0.20; the session resolves the model every
turn, so the change applies from the next turn. OpenRouter uses its live
pricing metadata. Thinking tokens are included in output billing. The Context
meter uses the same cumulative estimate as other Pi models.

Argon credential verification uses Low thinking, a 32,768-token ceiling and a
60-second deadline, because Argon always thinks before answering. Other models
retain their existing verification budgets.

References: [Argon migration guide](https://ai.google.dev/gemini-api/docs/generate-content/latest-model).

Validation: `backend/test/geminiArgon.test.ts` runs Pi's real Google provider and
`@google/genai` SDK with only `fetch` replaced. It checks that a Pi 1.4+
transcript's system prompt and tools reach the request, the 32,768-token output
cap, every effort level's `thinkingLevel`, stop-reason mapping and credential
verification budgets. On 2026-11-03 a replay of a failing real session against
the Google API confirmed the diagnosis: with Michi's tools declared, Argon called
`read_node` normally; without them, it returned `MALFORMED_FUNCTION_CALL`.
