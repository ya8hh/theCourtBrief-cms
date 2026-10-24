# Start the existing worker only when jobs need it

This changes the **existing EC2 instance**, not the public website. The CMS and database stay hosted as before. It does not create an EC2 instance, NAT gateway, public Lambda URL, disk, or load balancer. It does not terminate anything.

## Result

- Editorial uploads, generate, revise and retry actions already save jobs in PostgreSQL.
- An EventBridge rule invokes a small Lambda controller every minute. It is not an always-running server.
- The controller checks a dedicated authenticated CMS endpoint; no document text, API keys or drafts are returned.
- If work is due, it starts the existing worker EC2 instance. Its already-enabled systemd service starts at boot.
- Allow up to a minute for the check plus EC2/worker boot time; processing is not instant.
- Queued or running work prevents automatic shutdown. After **600 seconds (10 minutes)** of idle time, the CMS rechecks the queue under the same database lock as job claiming and puts the worker into drain mode. Lambda then stops the instance.
- Claims are blocked during draining, preventing a newly claimed job from being killed between the queue check and stop call. A job arriving after draining remains saved; the next check restarts/resumes the instance after it finishes stopping.
- Future quota retries remain saved while the instance sleeps. Once a retry is due, the next controller check starts the instance again.
- If CMS authentication, networking or status validation fails, the controller does **not** stop a running instance. This favors preserving work; check Lambda logs if the instance unexpectedly stays running.

## 1. Deploy the CMS changes first

Push the updated Desktop `cms` repository and redeploy Render. The additive migration creates `worker_power_state`; it does not change articles or jobs. Keep `WORKER_ON_DEMAND=false` until the AWS stack is ready. No new AWS keys belong in Render or editorial.

## 2. Generate a separate controller token ON YOUR MAC

```bash
python3 -c 'import secrets; print(secrets.token_hex(32))'
```

Privately copy this value to both Render's `WORKER_POWER_TOKEN` and the CloudFormation `PowerToken` parameter below. Do not send it in chat, commit it, or replace the existing `PROCESSOR_TOKEN` or encryption key. Use only ASCII letters/digits/underscore/hyphen. Save Render changes with on-demand still disabled.

## 3. Create one AWS stack in Sydney

Use the **same region as the existing worker: Asia Pacific (Sydney)**.

1. AWS console → CloudFormation → Create stack → With new resources (standard).
2. Choose an existing template → Upload a template file. Upload `cloudformation.json` in this directory.
3. Stack name: `courtroomdigest-worker-power`.
4. Parameters:
   - `InstanceId`: copy the current `courtbrief-worker` instance ID from EC2. The previously recorded ID is `i-00ff51f6e5b0ee4da`; verify it still identifies your worker.
   - `CmsUrl`: `https://thecourtbrief-cms.onrender.com` (no trailing slash).
   - `PowerToken`: paste the newly generated token, identical to Render.
5. Keep default stack options. Acknowledge that CloudFormation can create IAM resources, then create the stack.
6. Wait for **CREATE_COMPLETE**. The IAM role can only start/stop the supplied instance, describe instances, and write its own Lambda logs. The controller has no public HTTP endpoint. It uses AWS-managed temporary role credentials.

If stack creation fails due to account-specific Lambda concurrency limits, do not enable on-demand mode; inspect the CloudFormation error. The template reserves one controller invocation to prevent overlapping power decisions. Do not remove this protection without redesigning controller serialization.

## 4. Activate on Render

Set these CMS environment variables and redeploy:

```text
WORKER_ON_DEMAND=true
WORKER_IDLE_SECONDS=600
WORKER_POWER_TOKEN=<the same new private token>
```

Do not change the AWS worker `.env`, CMS URL, existing provider keys, or systemd service. This version needs only a CMS deploy and the AWS controller stack, **no worker archive upload**.

## 5. Verify the whole cycle before relying on savings

1. Confirm `courtbrief-worker` is the target EC2 instance and systemd service is enabled (previously configured).
2. With no work due, wait at least 10–12 minutes. EC2 should show **Stopped**, not Terminated.
3. Upload a real court PDF in editorial. The job should remain queued during boot, then process to a reviewable draft. EC2 should show Pending → Running.
4. Queue a revision or second document while processing. Confirm it finishes without shutdown mid-job.
5. After all work finishes and 10 idle minutes pass, confirm EC2 stops again.
6. Check a job deferred for provider quota automatically resumes when due. Do not manually retry a Waiting job.

A stopped instance's auto-assigned public IPv4 address/DNS may change on restart. Copy the current address from EC2 before the next SSH session. The worker only makes outbound HTTPS calls to Render, so it does not depend on a fixed address. Do not purchase an Elastic IP just for this.

## Rollback / emergency recovery

1. In CloudFormation's Outputs find the EventBridge rule and disable it in EventBridge **Rules**.
2. Set Render `WORKER_ON_DEMAND=false` and redeploy. This bypasses the drain gate.
3. Start the EC2 instance manually if stopped. Its systemd worker resumes the durable CMS queue.
4. Never terminate the instance or delete the production database. The stack can later be deleted without deleting the existing EC2 instance.

## Cost limits

EC2 compute charges cease while the instance is stopped; attached EBS storage still incurs charges. Lambda, EventBridge and logs have their own metering; this design reduces idle compute but does not promise a zero bill or extend AWS credit expiration. AWS credits expire on their own account-specific date. Review Billing by service to confirm the actual source of the daily charge. Do not add paid network infrastructure for this controller.

References:
- https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/Stop_Start.html
- https://repost.aws/knowledge-center/start-stop-lambda-eventbridge

## Local verification

`python -m pytest aws/on-demand/tests -q` tests the controller with mocked AWS and CMS; it makes no live calls. The sibling verification project exercises CMS auth, draining, queued/running protection, and due quota wake-up against isolated PostgreSQL. Actual start/stop behavior still requires the deployment checks above.
