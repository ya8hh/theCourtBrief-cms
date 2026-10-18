"""Small synthetic connectivity check. Never stores or publishes an article."""
import json
import os
from pathlib import Path
import httpx

root = Path(__file__).resolve().parents[1]
env_path = root / '.env'
if env_path.exists():
    for line in env_path.read_text().splitlines():
        if '=' in line and not line.startswith('#'):
            name, value = line.split('=', 1)
            os.environ.setdefault(name, value)
key = os.getenv('GEMINI_API_KEY', '').strip()
model = os.getenv('GEMINI_MODEL', 'gemini-3.8-flash').strip()
if not key:
    raise SystemExit('GEMINI_API_KEY is missing. Add it privately to the worker .env.')
payload = {'model': model, 'max_tokens': 512, 'response_format': {'type': 'json_object'},
           'messages': [{'role': 'user', 'content': 'Connectivity test only. Return exactly the JSON object {"ok":true}.'}]}
if model.startswith(('gemini-2.5-', 'gemini-3')):
    payload['reasoning_effort'] = 'low'
try:
    response = httpx.post('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
                          headers={'Authorization': 'Bearer ' + key}, json=payload, timeout=90)
    print('Gemini model:', model)
    print('HTTP status:', response.status_code)
    if response.is_error:
        try:
            error = response.json().get('error', {})
            message = str(error.get('message', 'Provider rejected request.'))
        except (ValueError, AttributeError):
            message = 'Provider rejected request; inspect your Google project and model access.'
        for name in ('GEMINI_API_KEY', 'LLM_API_KEY', 'LLM_FALLBACK_API_KEY', 'PROCESSOR_TOKEN'):
            secret = os.getenv(name)
            if secret:
                message = message.replace(secret, '[REDACTED]')
        print('Message:', message[:1200])
        raise SystemExit(1)
    body = response.json()
    choice = body['choices'][0]
    if choice.get('finish_reason') == 'length':
        raise SystemExit('Request accepted, but diagnostic output was truncated. Model access works; output configuration still needs checking.')
    if json.loads(choice['message']['content']) != {'ok': True}:
        raise SystemExit('Request accepted, but diagnostic JSON did not match. No generated content was stored.')
    print('Gemini key, model and JSON response check passed. No article was created.')
except httpx.HTTPError as error:
    raise SystemExit('Gemini network request failed (' + type(error).__name__ + '). Try later.')
except (ValueError, KeyError, TypeError, IndexError):
    raise SystemExit('Gemini replied, but its response could not be validated. No article was created.')
