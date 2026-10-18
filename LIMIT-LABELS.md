# Provider/model labels for token limits

Output-length failures now identify the provider, primary/backup slot, model and configured LLM_MAX_OUTPUT_TOKENS. OpenRouter uses its returned actual routed model when available, falling back to the requested router/model identifier. Logs emit providerOutputLimit with the same fields and no credentials. Rate-limit log records also include provider and requested model. Output truncation is distinguished from HTTP 429 rate limits; no incomplete article is accepted. Model labels are syntax-limited and redact credential-like values before they enter errors/logs.

Verification: 42 processor tests pass, covering output truncation on all four routes, actual OpenRouter model reporting, invalid/secret model-label sanitization, rate-limit labeling, routing/cooldown integrity, full schema validation, source preservation, token and cost accounting, PDF extraction.

Deploy worker-limit-labels-update.tar.gz into /home/ubuntu/courtbrief-worker between processing jobs and restart courtbrief-worker. Existing .env, keys, schemas and prompts are preserved. Combined provider-worker-update.tar.gz is also refreshed to include this version. Existing failed jobs retain their historical generic errors: retry generation after installing for the labeled error. No provider was contacted or AWS change performed locally.
