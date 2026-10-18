# Groq paid-primary / free-backup update

LLM_API_KEY is the paid primary. LLM_FALLBACK_API_KEY is the existing free key. Keep both only in the AWS worker .env; CMS and frontend do not need either key. Leave PROCESSOR_TOKEN unchanged. Both credentials use the same LLM_BASE_URL and LLM_MODEL.

Only HTTP 429 triggers failover. The worker honors Retry-After (seconds or HTTP date), retains cooldown across documents in the running process, deduplicates identical keys, prefers primary again after expiry, and bounds requests and waiting. Cooldowns reset on process restart; do not restart to evade a quota. Keys within the same Groq organization can share limits. HTTP 401/403 and validation failures are reported rather than silently switching accounts.

The worker never logs either key; rate-limit logs identify only primary/fallback. Observed token usage aggregates across both accounts. Configure conservative pricing if using the existing cost cap; this is not a replacement for Groq billing controls. Requests can incur paid usage.

Update on AWS: stop courtbrief-worker, extract the archive into /home/ubuntu/courtbrief-worker, edit its .env with paid LLM_API_KEY and free LLM_FALLBACK_API_KEY, preserve the model/base URL and processor token, chmod 600 .env, then start courtbrief-worker and inspect journalctl. Do this between active document jobs. For rollback, restore processor/processor.py from a backup and restart; the old worker ignores LLM_FALLBACK_API_KEY.

Verification: 17 processor tests pass, including primary-to-backup failover, cooldown across documents and primary recovery, both-limited handling, identical-key deduplication, actual request budget, HTTP-date delays, rejection of bad credentials, schema validation, PDF extraction and token/cost accounting. No live paid API call or AWS change was performed here.
