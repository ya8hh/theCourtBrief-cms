# Deploy saved progress and editorial provider keys

This update changes **CMS**, **editorial**, and the **AWS worker**. The public client does not need a redeploy. Existing credentials remain in the worker environment until the first key is saved through editorial. No hosted service was changed automatically.

## 1. Deploy the CMS on Render

Push the updated `cms` project to its existing GitHub repository. Keep the current Render environment variables and database; do not recreate either. In particular, preserve **ENCRYPTION_KEY** and **PROCESSOR_TOKEN**. ENCRYPTION_KEY must be a stable secret at least 32 characters long; your earlier generated value is suitable. New keys are encrypted with AES-256-GCM under that secret. Losing or changing it makes saved keys unreadable. Back it up separately and privately.

Take a PostgreSQL backup before deployment. The new migration adds checkpoint, progress, retry scheduling and crash-count columns to processing_jobs, adds a waiting state to the active-job index, and creates the encrypted credential/settings tables. Existing articles, source documents and processing history are preserved. Strapi runs migrations on startup. Check `/api/health` after Render reports Live.

## 2. Deploy editorial on Netlify

Push the updated `editorial` project to its existing repository and redeploy. Keep the current CMS_URL, CMS_PUBLIC_URL, SITE_URL and PUBLIC_SITE_URL. Sign in using your hosted **super administrator** account. Reporters/publishers cannot manage provider keys. Open **AI providers** in the navigation, or `/editorial/settings`.

The form visibly identifies Groq, Google Gemini and OpenRouter. You can save multiple keys for each provider. Each row shows your label, provider, model, masked key hint, numeric priority, enabled state and cooldown. Smaller priorities run first. Full keys are never returned after saving. Replace, disable or delete each key independently. Provider URLs are fixed; arbitrary endpoints are not accepted. OpenRouter is restricted to `openrouter/free` or an explicit `:free` model.

## 3. Update the AWS worker once

Wait until no document is processing. In a **Mac Terminal** (`yashpal@…`), upload the provided `worker-resume-update.tar.gz`:

```sh
scp -i ~/Downloads/courtbrief-worker-key-aws.pem ~/Desktop/theCourtBrief/cms/worker-resume-update.tar.gz ubuntu@ec2-54-252-248-41.ap-southeast-2.compute.amazonaws.com:~/
```

Connect using SSH. Only at the **AWS prompt** (`ubuntu@…`) run:

```sh
sudo systemctl stop courtbrief-worker
cd ~/courtbrief-worker
tar -czf ~/courtbrief-worker-before-resume.tar.gz processor resources
# This update contains code/resources only; it preserves your .env and Python virtual environment.
tar -xzf ~/worker-resume-update.tar.gz
processor/.venv/bin/pip install --no-cache-dir -r processor/requirements.txt
sudo systemctl start courtbrief-worker
sudo systemctl status courtbrief-worker --no-pager
```

If your server DNS or key filename changed, substitute the current values. SSH must allow your current IP. The existing systemd service remains valid. CMS_URL and PROCESSOR_TOKEN are still required on AWS; provider keys will subsequently be supplied by the CMS. AI_ENABLED=true remains required on CMS and worker. The default AI request budget is now 2000 per document; if your AWS .env explicitly sets MAX_AI_CALLS_PER_DOCUMENT=100, increase it thoughtfully for 500-page documents. Requests and provider charges remain bounded by your configured limits.

Deploy the worker only **after** the CMS update, because it uses the new checkpoint/config endpoints. Until updated, old workers will continue using environment keys and cannot use web-managed credentials.

## 4. Add your keys through editorial

Add a label such as **Groq paid 1**, choose **Groq**, select your permitted model (for example openai/gpt-oss-120b), paste the key privately and choose priority 10. Add another Groq key at 20, Gemini at 30 and OpenRouter at 40, or choose a different order.

**The first saved key makes the CMS list authoritative.** Add all existing keys you want to keep using. Disabled/deleted keys never silently fall back to stale AWS environment keys. With no enabled keys, processing waits rather than failing or using removed keys. Workers refresh configuration before uncached model requests; no AWS edit or restart is needed for future key additions, rotations or disabling. Adding or updating a key wakes waiting jobs while preserving existing provider cooldowns. Requests already in flight may finish before a disable takes effect.

Prices are optional USD amounts per million tokens. Leave unknown prices blank, never invent zero for a paid model. With a per-document cost cap configured, an unpriced provider is blocked before spending. Token/cost accounting includes saved work across resumptions. Free OpenRouter variants have zero inference pricing but still have request limits and variable quality/availability; human review remains required. Gemini free-tier content may be used to improve Google's products. Verify current pricing and data-use policies in your provider dashboards.

## 5. Test a long document

Use a direct official court PDF link. Previously failed documents can be retried once; old versions had no checkpoints, so they need to begin analysis again. Updated jobs save every successful analysis/reduction/draft/verification step in PostgreSQL. The workspace displays the current phase, completed/total sections and next retry time.

A quota-limited job becomes **waiting**, releases its lease, and automatically resumes when due. Completed steps are reused after a worker restart or a manual retry of a genuinely failed job. Quota resumes do not consume crash-recovery attempts. Cached steps are bound to source text, editorial metadata/instructions/prior draft, prompt/schema and context budget. Changing these invalidates incompatible saved work. Increasing the output-token budget preserves valid analysis and its original section plan. No source pages are silently dropped; the final grounding checks still cover every source section.

A crash during a provider call or before checkpoint acknowledgment can repeat that one in-flight step. Completed acknowledged steps are durable. Too-large checkpoints, invalid model output, incompatible models or exhausted configured cost/request budgets still stop with a clear error and saved progress. Automatic checkpoint/resume does not guarantee factual accuracy, provider capacity or unlimited free processing.

## Verification

- 51 Python tests, including a synthetic 500-page interruption/resume test and checking all source tails.
- 20 TypeScript unit tests and 37 full HTTP integration checks, including real native PostgreSQL migrations, multiple keys per provider, stale-lease fencing, waiting/resume, CSRF and secret hiding.
- Independent CMS/editorial lint, type checks and production builds.
- No test legal content, credentials or users enter the hosted CMS. No live paid provider request was used during verification.
