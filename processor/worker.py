"""Pull-based worker. The CMS owns leases, retries, source storage and audit history."""
import os, time, socket, json, threading
from pathlib import Path
import httpx
from processor import extract_isolated, generate

def run_once(client):
    response=client.post('/api/worker/claim',json={'worker':socket.gethostname()})
    response.raise_for_status()
    job=response.json().get('data')
    if not job:return False
    ident,lease=job['id'],job['lease_token']
    stopped=threading.Event()
    def heartbeat():
        while not stopped.wait(20):
            try:
                response=client.post(f'/api/worker/jobs/{ident}/heartbeat',json={'lease':lease})
                response.raise_for_status()
            except httpx.HTTPError:
                # Fenced completion rejects any result after another worker owns the lease.
                break
    renew=threading.Thread(target=heartbeat,daemon=True);renew.start()
    try:
        if job['kind']=='extract':
            pdf=client.get(f'/api/worker/jobs/{ident}/pdf',params={'lease':lease});pdf.raise_for_status()
            result=extract_isolated(pdf.content)
            if result['sha256']!=job['checksum']:raise ValueError('Stored PDF checksum does not match source record.')
        else:
            result=generate(job['extraction'],job['metadata'],job['payload'].get('instruction',''),job['payload'].get('prior'))
        result_response=client.post(f'/api/worker/jobs/{ident}/complete',json={'lease':lease,'result':result})
        if result_response.is_error: raise ValueError("CMS rejected processing result: "+result_response.text[:1500])
    except Exception as exc:
        failure=client.post(f'/api/worker/jobs/{ident}/complete',json={'lease':lease,'error':str(exc)[:1500],'usage':getattr(exc,'usage',None)})
        if failure.is_error: raise ValueError("CMS rejected failure report: "+failure.text[:1500])
    finally:
        stopped.set();renew.join(timeout=2)
    return True

if __name__=='__main__':
    env_path=Path(__file__).resolve().parents[1]/'.env'
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            if '=' in line and not line.startswith('#'):
                key,value=line.split('=',1);os.environ.setdefault(key,value)
    # A single local worker per CMS prevents older processes with stale configuration
    # from competing for the same jobs. Containers retain independent lock files.
    import fcntl, hashlib, tempfile
    endpoint=os.getenv('CMS_URL','http://127.0.0.1:1337')
    lock_path=Path(tempfile.gettempdir())/('court-worker-'+hashlib.sha256(endpoint.encode()).hexdigest()[:16]+'.lock')
    worker_lock=lock_path.open('a')
    try:
        fcntl.flock(worker_lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    except BlockingIOError:
        raise SystemExit('A worker is already running for this CMS. Stop it before starting another worker.')
    print(json.dumps({'workerStarted':True,'aiEnabled':os.getenv('AI_ENABLED','false').lower()=='true','model':os.getenv('LLM_MODEL')}),flush=True)
    token=os.environ.get('PROCESSOR_TOKEN')
    if not token:raise SystemExit('PROCESSOR_TOKEN is required.')
    with httpx.Client(base_url=os.getenv('CMS_URL','http://127.0.0.1:1337'),headers={'Authorization':'Bearer '+token},timeout=150,follow_redirects=False) as client:
        while True:
            try:
                if not run_once(client):time.sleep(2)
            except (httpx.HTTPError,ValueError) as exc:
                print(json.dumps({'workerError':str(exc)}),flush=True);time.sleep(5)
