# Combined provider update

Order: primary paid Groq, optional free Groq, optional Gemini, optional OpenRouter. A provider is enabled only when its own API key is configured. Keep keys exclusively in the AWS worker .env; PROCESSOR_TOKEN and CMS/frontend settings do not change. Google and OpenRouter are independent services, subject to their own usage limits and data policies. Never paste keys in chat or commit .env.

OpenRouter: OPENROUTER_API_KEY and OPENROUTER_MODEL=openrouter/free. Paid OpenRouter routes are explicitly rejected: only openrouter/free or an explicit :free model is accepted. Free routing selects a varying model, so editorial review remains required and model quality/availability are not guaranteed. Require JSON-capable providers and validate full article schema locally. Groq-specific reasoning fields are not forwarded. Actual returned model is recorded in usage when supplied. Only rate limits trigger cross-provider failover; schema failures keep bounded recovery and validation. Request counts/cooldown budgets and cost caps remain active. Free router prices are zero per official docs; Gemini prices remain account-specific and unknown unless configured. Gemini is optional, and a faulty configured Gemini credential fails visibly rather than being ignored.

Local connection checks (each makes one small synthetic API request, writes no CMS content): processor/.venv/bin/python processor/check_gemini.py and processor/.venv/bin/python processor/check_openrouter.py.

Install provider-worker-update.tar.gz under /home/ubuntu/courtbrief-worker between document jobs, edit .env privately, then restart courtbrief-worker. Existing resources and .env are preserved. Archive includes both checks, worker source, tests and this guide. Previous model/schema/failover fixes are included; separate prior patches are unnecessary.

Verification: 36 tests pass, including four-provider routing, no cross-provider credential leak, source preservation, independent cooldowns, invalid JSON rejection, paid-router-model blocking, correct actual-model tracking, request and cost budgets and extraction. No remote deployment or live provider key check was performed.

References: https://openrouter.ai/docs/guides/routing/routers/free-router and https://openrouter.ai/docs/api/reference/limits
