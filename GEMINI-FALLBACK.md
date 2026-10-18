# Optional Gemini fallback

Order: primary LLM_API_KEY, backup LLM_FALLBACK_API_KEY, then GEMINI_API_KEY. Existing Groq settings are unchanged. Gemini uses its own fixed official HTTPS OpenAI-compatible endpoint and GEMINI_MODEL (default gemini-3.8-flash, listed with free API usage in Google pricing checked 2026-10-18). Verify model availability and free quotas in the user's own AI Studio project; the default is configurable. A key from a billing-enabled project can incur paid Google charges. Free-tier content may be used to improve Google products; send only appropriate public court material.

Set GEMINI_API_KEY and GEMINI_MODEL in the AWS worker .env, not in CMS, editorial or public frontend variables. Keys must have no quotes under the current simple env loader. Keep PROCESSOR_TOKEN unchanged. Protect .env with chmod 600. Restart after installation. Optional connectivity check: processor/.venv/bin/python processor/check_gemini.py (one small synthetic request, no CMS write or published article).

Only 429 triggers cross-provider failover. Keep retry cooldowns and request/wait budgets. Gemini output uses JSON-object mode with an explicit schema in the prompt and mandatory local JSON Schema validation. Grounding checks are unchanged. Bad credentials, forbidden models, invalid output and non-schema 400 errors fail visibly. No credential or source text appears in routing logs. Cooldown is process-local and resets on restart; do not restart to bypass limits. Requests do not resume saved intermediate progress after a job failure; long documents can still need many calls.

Token usage aggregates across providers and modelsUsed identifies models with observed generation usage. Gemini pricing is configured separately via GEMINI_INPUT_PRICE_PER_MILLION/GEMINI_OUTPUT_PRICE_PER_MILLION; an unpriced fallback yields unknown estimatedCost, never Groq-derived pricing. An enabled per-document cost cap blocks Gemini before sending unless its prices are configured. No default zero/free price is invented.

Verification: 30 processor tests pass. Coverage includes real HTTP-shaped fixtures for paid/free/Gemini routing, credential separation, cooldown across jobs, all providers limited, schema enforcement, partial usage, pricing/cap integrity, source preservation and extraction. No live Google call or AWS deployment was performed. Install archive contains source, tests and diagnostic only; no keys or .env.

Sources: https://ai.google.dev/gemini-api/docs/openai and https://ai.google.dev/gemini-api/docs/pricing
