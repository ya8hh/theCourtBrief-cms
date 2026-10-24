"""Scheduled Lambda: start for due work, drain safely, stop after an idle grace period.
No public endpoint, no IAM credentials on Render, and no access to document contents.
"""
import json
import os
import urllib.request
import urllib.parse
import boto3

def cms(action):
    base = os.environ['CMS_URL'].rstrip('/')
    url = urllib.parse.urlparse(base)
    if url.scheme != 'https' or url.username or url.password or url.path not in ('', '/'):
        raise ValueError('CMS_URL must be an HTTPS origin.')
    request = urllib.request.Request(base + '/api/worker/power',
        data=json.dumps({'action': action}).encode(), method='POST',
        headers={'Authorization': 'Bearer ' + os.environ['POWER_TOKEN'], 'Content-Type': 'application/json'})
    # Never forward the controller token to a redirect target.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None
    with urllib.request.build_opener(NoRedirect()).open(request, timeout=45) as response:
        data = json.load(response)['data']
    if not isinstance(data.get('busy'), bool) or data.get('mode') not in ('active','draining') or not isinstance(data.get('canStop'), bool):
        raise ValueError('Invalid CMS power response; no EC2 action taken.')
    return data

def handler(event, context):
    ec2 = boto3.client('ec2')
    instance = os.environ['INSTANCE_ID']
    response = ec2.describe_instances(InstanceIds=[instance])
    state = response['Reservations'][0]['Instances'][0]['State']['Name']
    if state in ('pending','stopping'):
        return {'action':'transitioning'}
    if state not in ('running','stopped'):
        return {'action':'unsupported-instance-state'}
    # Any CMS/network/auth failure raises before stopping the instance.
    work = cms('inspect')
    if work['busy']:
        cms('resume')
        if state == 'stopped':
            ec2.start_instances(InstanceIds=[instance])
            print(json.dumps({'workerPower':'started-for-work'}))
            return {'action':'started-for-work'}
        return {'action':'processing'}
    if state == 'stopped':
        return {'action':'sleeping'}
    work = cms('drain')  # Atomic recheck + block new claims under the same DB lock.
    if work['canStop'] and not work['busy'] and work['mode'] == 'draining':
        ec2.stop_instances(InstanceIds=[instance])
        print(json.dumps({'workerPower':'stopped-after-idle'}))
        return {'action':'stopped-idle-worker'}
    return {'action':'idle-grace-period'}
