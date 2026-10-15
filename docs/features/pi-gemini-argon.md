# Gemini 4 Argon in Pi

Select **Pi → Google AI → Gemini 4 Argon** in Settings → Model or the Composer.
Configure a paid Gemini API key from [Google AI Studio](https://aistudio.google.com/app/apikey)
in Settings, or supply `GEMINI_API_KEY` to the backend. API billing is separate
from the Gemini application's subscription. Existing explicit model choices
are retained; the Google provider's default for new selections is Argon.

The model ID is `gemini-4-argon`. Google and OpenRouter's
`google/gemini-4-argon` expose **Low / Medium / High**, with Medium as the
default. Unsupported legacy effort choices clamp to the nearest supported
level. Google requests use `thinkingLevel`, never the legacy `thinkingBudget`.

## Output and continuation

Argon shares 1,048,576 tokens between input, thinking, and output. The Google
adapter defaults to a total thinking/output ceiling of **262,144 tokens** and
reserves room for the estimated prompt plus a 4,096-token safety margin.
To change the ceiling, set `MICHI_GEMINI_ARGON_MAX_OUTPUT_TOKENS` on the backend
to an integer between 1 and 1,048,576. For example:

```sh
MICHI_GEMINI_ARGON_MAX_OUTPUT_TOKENS=65536 npm start
```

Larger limits allow deeper reasoning and can increase spend; they do not require
the model to produce longer answers. Thinking tokens are included in output billing.
OpenRouter retains the completion limit advertised by its live catalog.

Google uses the pinned `@google/genai` 2.29.1 SDK with an explicit streaming
continuation loop. Every hop retains the original contents, system prompt,
tools, generation configuration and total output ceiling. Only the encrypted
continuation token changes. Hops produce one Pi assistant message and one
terminal event; tool calls execute through Pi's usual permission policy.

Streams remain live until the first provider checkpoint. After a checkpoint,
the adapter buffers the uncommitted tail until the next checkpoint or normal
completion. If the stream disconnects, this tail is discarded and generation
resumes from the last checkpoint, up to two retries per checkpoint. An initial
request that fails without a checkpoint is not replayed. Safety/protocol errors
and user cancellation are not retried. A hop has a 20-minute timeout; user
cancellation settles the Pi stream promptly, even while waiting for a chunk.

Signed text, thinking and tool parts retain their signatures in Pi's live
history for subsequent Google requests. Existing Pi SQLite recovery remains
text-based; this change does not introduce native Google session persistence.

## Usage and verification

Billing totals include input, cached input, thinking and output across all hops.
The Context meter uses the original prompt and current generated tokens rather
than adding repeated billed prompts. Generated tails discarded after a network
failure remain billable when the provider reports their usage.

Google introductory pricing through November 30, 2026 is $2 input, $10 output,
and $0.10 cached input per million tokens. Starting December 1 UTC, the adapter
uses $4 / $20 / $0.20. OpenRouter uses its live pricing metadata.

Argon credential verification uses Low thinking, a 32,768-token ceiling and a
60-second deadline. Other models retain their existing verification budgets.
The current Pi package and its Google SDK are retained for other models.

References: [Argon migration guide](https://ai.google.dev/gemini-api/docs/generate-content/latest-model),
[long decode protocol](https://ai.google.dev/gemini-api/docs/generate-content/long-decode).

Validation uses isolated provider fixtures, a real SDK against a local HTTP/SSE
server, a Pi agent tool loop, and the browser's mock API. These checks do not
claim acceptance by a paid Google account.

On October 14, 2026, a live Google API smoke check also completed a short text
response and a Pi tool call followed by a final answer, with the signed tool
history accepted by Google. Actual output beyond 64K and network checkpoint
recovery were verified with isolated fixtures rather than a costly live decode.
