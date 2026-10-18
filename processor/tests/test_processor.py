import json, sys, hashlib
from pathlib import Path
import pytest, pymupdf
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import processor

def pdf(text='TEST ONLY. Supreme Court integration source. The petition is dismissed. This is synthetic test text, never production news.'):
    d=pymupdf.open();p=d.new_page();p.insert_textbox(p.rect+ (40,40,-40,-40),text,fontsize=12);data=d.tobytes();d.close();return data

def test_extraction_isolated_preserves_page_and_checksum():
    data=pdf();r=processor.extract_isolated(data)
    assert r['pageCount']==1 and '[Page 1]' in r['text'] and 'petition is dismissed' in r['text']
    assert r['sha256']==hashlib.sha256(data).hexdigest() and not r['ocrRequired']

def test_bad_pdf_size_and_scanned_detection(monkeypatch):
    with pytest.raises(processor.ProcessingError):processor.extract_bytes(b'not pdf')
    with pytest.raises(processor.ProcessingError):processor.extract_bytes(b'%PDF-1.4 corrupted')
    monkeypatch.setenv('MAX_UPLOAD_BYTES','10')
    with pytest.raises(processor.ProcessingError):processor.extract_bytes(pdf())
    monkeypatch.delenv('MAX_UPLOAD_BYTES')
    assert processor.extract_bytes(pdf(''))['ocrRequired']

def test_password_and_page_limits(monkeypatch):
    d=pymupdf.open();d.new_page();data=d.tobytes(encryption=pymupdf.PDF_ENCRYPT_AES_256,owner_pw='owner',user_pw='password');d.close()
    with pytest.raises(processor.ProcessingError,match='Password'):processor.extract_bytes(data)
    monkeypatch.setenv('MAX_PDF_PAGES','0')
    with pytest.raises(processor.ProcessingError,match='page limit'):processor.extract_bytes(pdf())

def test_chunks_never_drop_tail_or_multibyte():
    text='[Page 1]\n'+'न्यायालय '*1000+'\nTAIL FINAL ORDER'
    pieces=list(processor.chunks(text,1200));assert ''.join(pieces)==text and all(len(p.encode())<=1200 for p in pieces)

def test_ai_disabled_and_ocr_blocked(monkeypatch):
    monkeypatch.setenv('AI_ENABLED','false')
    with pytest.raises(processor.ProcessingError,match='disabled'):processor.generate({'text':'x'*200},{})
    with pytest.raises(processor.ProcessingError,match='OCR'):processor.generate({'text':'x'*200,'ocrRequired':True},{})

def draft():
    return {k:[] if v.get('type')=='array' else None for k,v in processor.SCHEMA['properties'].items()}|{'headline':'TEST ONLY ruling','summary':'TEST ONLY summary','articleBody':'TEST ONLY article','documentType':'Judgment','finalOutcome':'Dismissed'}

def test_hierarchical_generation_and_usage(monkeypatch):
    monkeypatch.setenv('LLM_CONTEXT_BYTES','18000');monkeypatch.setenv('LLM_MAX_OUTPUT_TOKENS','1000')
    class Fake:
        calls=[]
        def __init__(self):pass
        def call(self,task,source,schema=None):
            self.calls.append((task,source));return draft() if schema else {'warnings':[]} if task.startswith('Check') else {'verifiedFacts':['TEST ONLY'],'pageReferences':['Page 1']}
        def usage(self):return {'model':'test-provider','inputTokens':123,'outputTokens':45,'requests':len(self.calls),'estimatedCost':None}
    monkeypatch.setattr(processor,'Provider',Fake)
    r=processor.generate({'text':'[Page 1]\n'+('Synthetic test source. '*2000)+'TAIL OPERATIVE ORDER'}, {})
    assert r['usage']['inputTokens']==123 and len(Fake.calls)>4
    assert any('TAIL OPERATIVE ORDER' in source for task,source in Fake.calls if task.startswith('Analyze'))
    assert any('TAIL OPERATIVE ORDER' in source for task,source in Fake.calls if task.startswith('Check'))

def test_provider_schema_timeout_and_cost(monkeypatch):
    monkeypatch.setenv('AI_ENABLED','true');monkeypatch.setenv('LLM_MODEL','test-model');monkeypatch.setenv('LLM_API_KEY','test-only')
    class Reply:
        status_code = 200
        def raise_for_status(self):pass
        def json(self):return {'choices':[{'finish_reason':'stop','message':{'content':json.dumps(draft())}}],'usage':{'prompt_tokens':100,'completion_tokens':20}}
    class Client:
        def __init__(self,**kwargs):pass
        def __enter__(self):return self
        def __exit__(self,*args):pass
        def post(self,*args,**kwargs):return Reply()
    monkeypatch.setattr(processor.httpx,'Client',Client)
    p=processor.Provider();assert p.call('test','source',processor.SCHEMA)['headline']=='TEST ONLY ruling';assert p.usage()['inputTokens']==100
    monkeypatch.setenv('MAX_AI_COST_PER_DOCUMENT','1')
    with pytest.raises(processor.ProcessingError,match='pricing'):processor.Provider()
    monkeypatch.setenv('LLM_INPUT_PRICE_PER_MILLION','100');monkeypatch.setenv('LLM_OUTPUT_PRICE_PER_MILLION','100');monkeypatch.setenv('MAX_AI_COST_PER_DOCUMENT','0.0001')
    with pytest.raises(processor.ProcessingError,match='cost cap'):processor.Provider().call('test','source')

def test_schema_rejects_invented_fields():
    import jsonschema
    jsonschema.validate(draft(),processor.SCHEMA)
    with pytest.raises(jsonschema.ValidationError):jsonschema.validate(draft()|{'fakeCitation':'invented'},processor.SCHEMA)

def test_provider_timeout_and_invalid_schema_keep_observed_usage(monkeypatch):
    monkeypatch.setenv('AI_ENABLED','true');monkeypatch.setenv('LLM_MODEL','test-model');monkeypatch.setenv('LLM_API_KEY','test-only')
    class Client:
        def __init__(self,**kwargs):pass
        def __enter__(self):return self
        def __exit__(self,*args):pass
        def post(self,*args,**kwargs):raise processor.httpx.ReadTimeout('TEST ONLY timeout')
    monkeypatch.setattr(processor.httpx,'Client',Client)
    with pytest.raises(processor.ProcessingError,match='ReadTimeout'):processor.Provider().call('test','source',processor.SCHEMA)
    class Reply:
        status_code = 200
        def raise_for_status(self):pass
        def json(self):return {'choices':[{'finish_reason':'stop','message':{'content':'{"inventedField":"invalid"}'}}],'usage':{'prompt_tokens':9,'completion_tokens':8}}
    monkeypatch.setattr(Client,'post',lambda *args,**kwargs:Reply())
    p=processor.Provider()
    with pytest.raises(processor.ProcessingError,match='ValidationError'):p.call('test','source',processor.SCHEMA)
    assert p.usage()['inputTokens']==9 and p.usage()['outputTokens']==8

def test_scanned_image_page_ocr_routing_and_failure(monkeypatch):
    d=pymupdf.open();page=d.new_page();pix=pymupdf.Pixmap(pymupdf.csRGB,pymupdf.IRect(0,0,200,200),False);pix.clear_with(150);page.insert_image(page.rect,pixmap=pix);data=d.tobytes();d.close()
    monkeypatch.setenv('OCR_ENABLED','false');r=processor.extract_bytes(data);assert r['scannedPages']==[1] and r['ocrRequired']
    monkeypatch.setenv('OCR_ENABLED','true')
    def failed(*args,**kwargs):raise RuntimeError('TEST ONLY unavailable OCR')
    monkeypatch.setattr(pymupdf.Page,'get_textpage_ocr',failed)
    r=processor.extract_bytes(data);assert r['ocrRequired'] and any('OCR failed' in w for w in r['warnings'])


def test_provider_retries_rate_limit_without_counting_failed_tokens(monkeypatch):
    monkeypatch.setenv('AI_ENABLED', 'true')
    monkeypatch.setenv('LLM_MODEL', 'test-model')
    monkeypatch.setenv('LLM_API_KEY', 'test-only')
    replies = [
        processor.httpx.Response(429, headers={'retry-after': '2'}, request=processor.httpx.Request('POST', 'https://provider.test/chat/completions')),
        processor.httpx.Response(200, json={'choices': [{'finish_reason': 'stop', 'message': {'content': json.dumps(draft())}}], 'usage': {'prompt_tokens': 100, 'completion_tokens': 20}}, request=processor.httpx.Request('POST', 'https://provider.test/chat/completions')),
    ]
    delays = []
    class Client:
        def __init__(self, **kwargs): pass
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def post(self, *args, **kwargs): return replies.pop(0)
    monkeypatch.setattr(processor.httpx, 'Client', Client)
    monkeypatch.setattr(processor.time, 'sleep', delays.append)
    provider = processor.Provider()
    assert provider.call('Generate', 'Source', processor.SCHEMA)['headline'] == draft()['headline']
    assert delays == [3]
    assert provider.usage()['inputTokens'] == 100
    assert provider.usage()['requests'] == 2
    assert not replies

@pytest.fixture(autouse=True)
def isolated_credentials(monkeypatch):
    processor._KEY_COOLDOWNS.clear()
    monkeypatch.delenv('LLM_FALLBACK_API_KEY', raising=False)
    monkeypatch.delenv('GEMINI_API_KEY', raising=False)
    monkeypatch.delenv('GEMINI_MODEL', raising=False)
    monkeypatch.delenv('OPENROUTER_API_KEY', raising=False)
    monkeypatch.delenv('OPENROUTER_MODEL', raising=False)
    monkeypatch.setattr(processor.time, 'monotonic', lambda: 0.0)
    yield
    processor._KEY_COOLDOWNS.clear()

def setup_failover(monkeypatch, statuses, retry='120'):
    monkeypatch.setenv('AI_ENABLED', 'true')
    monkeypatch.setenv('LLM_MODEL', 'test-model')
    monkeypatch.setenv('LLM_API_KEY', 'TEST-PRIMARY')
    monkeypatch.setenv('LLM_FALLBACK_API_KEY', 'TEST-BACKUP')
    used = []
    class Client:
        def __init__(self, **kwargs): pass
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def post(self, url, headers, **kwargs):
            used.append(headers['Authorization'])
            status = statuses.pop(0)
            return processor.httpx.Response(status, headers={'retry-after': retry}, json={'choices': [{'finish_reason': 'stop', 'message': {'content': '{"ok":true}'}}], 'usage': {'prompt_tokens': 1, 'completion_tokens': 2}}, request=processor.httpx.Request('POST', url))
    monkeypatch.setattr(processor.httpx, 'Client', Client)
    return used

def test_paid_primary_fails_over_and_cooldown_survives_documents(monkeypatch):
    used = setup_failover(monkeypatch, [429, 200, 200, 200])
    assert processor.Provider().call('test', 'source') == {'ok': True}
    assert processor.Provider().call('test', 'source') == {'ok': True}
    assert used == ['Bearer TEST-PRIMARY', 'Bearer TEST-BACKUP', 'Bearer TEST-BACKUP']
    monkeypatch.setattr(processor.time, 'monotonic', lambda: 122.0)
    processor.Provider().call('test', 'source')
    assert used[-1] == 'Bearer TEST-PRIMARY'

def test_both_limited_do_not_retry_before_long_cooldown(monkeypatch):
    used = setup_failover(monkeypatch, [429, 429])
    with pytest.raises(processor.ProcessingError, match='cooling down'):
        processor.Provider().call('test', 'source')
    assert len(used) == 2
    with pytest.raises(processor.ProcessingError, match='cooling down'):
        processor.Provider().call('test', 'source')
    assert len(used) == 2

def test_identical_keys_are_not_rotated(monkeypatch):
    used = setup_failover(monkeypatch, [429])
    monkeypatch.setenv('LLM_FALLBACK_API_KEY', 'TEST-PRIMARY')
    with pytest.raises(processor.ProcessingError, match='cooling down'):
        processor.Provider().call('test', 'source')
    assert used == ['Bearer TEST-PRIMARY']

def test_invalid_key_does_not_silently_switch(monkeypatch):
    used = setup_failover(monkeypatch, [401])
    with pytest.raises(processor.ProcessingError, match='rejected'):
        processor.Provider().call('test', 'source')
    assert used == ['Bearer TEST-PRIMARY']

def test_failover_obeys_actual_request_budget(monkeypatch):
    used = setup_failover(monkeypatch, [429])
    monkeypatch.setenv('MAX_AI_CALLS_PER_DOCUMENT', '1')
    with pytest.raises(processor.ProcessingError, match='request budget'):
        processor.Provider().call('test', 'source')
    assert len(used) == 1

def test_retry_after_supports_http_dates(monkeypatch):
    monkeypatch.setattr(processor.time, 'time', lambda: 0)
    assert processor.retry_delay('Thu, 01 Jan 1970 00:02:00 GMT') == 121
    assert processor.retry_delay('not a date') == 61

def schema_recovery_client(monkeypatch, responses):
    monkeypatch.setenv('AI_ENABLED', 'true')
    monkeypatch.setenv('LLM_MODEL', 'test-model')
    monkeypatch.setenv('LLM_API_KEY', 'TEST-PRIMARY')
    monkeypatch.setenv('LLM_FALLBACK_API_KEY', 'TEST-BACKUP')
    seen = []
    class Client:
        def __init__(self, **kwargs): pass
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def post(self, url, headers, json):
            seen.append((headers['Authorization'], __import__('copy').deepcopy(json)))
            status, body = responses.pop(0)
            return processor.httpx.Response(status, json=body, request=processor.httpx.Request('POST', url))
    monkeypatch.setattr(processor.httpx, 'Client', Client)
    return seen

def valid_response(value=None):
    return {'choices': [{'finish_reason': 'stop', 'message': {'content': json.dumps(draft() if value is None else value)}}], 'usage': {'prompt_tokens': 100, 'completion_tokens': 20}}

def test_json_schema_failure_recovers_same_key_and_preserves_source(monkeypatch):
    seen = schema_recovery_client(monkeypatch, [(400, {'error': {'code': 'json_validate_failed'}, 'usage': {'prompt_tokens': 12, 'completion_tokens': 4}}), (200, valid_response())])
    p = processor.Provider()
    assert p.call('Generate', '[Page 137] TAIL OPERATIVE SOURCE', processor.SCHEMA)['headline'] == draft()['headline']
    assert [x[0] for x in seen] == ['Bearer TEST-PRIMARY'] * 2
    assert seen[0][1]['response_format']['type'] == 'json_schema'
    assert seen[1][1]['response_format']['type'] == 'json_object'
    assert seen[0][1]['messages'] == seen[1][1]['messages']
    assert 'TAIL OPERATIVE SOURCE' in seen[1][1]['messages'][1]['content']
    assert all(k in seen[1][1]['messages'][0]['content'] for k in processor.SCHEMA['required'])
    assert p.usage()['requests'] == 2
    assert p.usage()['inputTokens'] == 112

def test_recovery_never_accepts_missing_article_fields(monkeypatch):
    seen = schema_recovery_client(monkeypatch, [(400, {'error': {'code': 'json_validate_failed'}}), (200, valid_response({}))])
    with pytest.raises(processor.ProcessingError, match='ValidationError'):
        processor.Provider().call('Generate', 'source', processor.SCHEMA)
    assert len(seen) == 2

def test_schema_recovery_is_bounded(monkeypatch):
    seen = schema_recovery_client(monkeypatch, [(400, {'error': {'code': 'json_validate_failed'}})] * 2)
    with pytest.raises(processor.ProcessingError, match='incomplete or invalid JSON'):
        processor.Provider().call('Generate', 'source', processor.SCHEMA)
    assert len(seen) == 2

def test_other_bad_requests_do_not_trigger_schema_fallback(monkeypatch):
    seen = schema_recovery_client(monkeypatch, [(400, {'error': {'code': 'model_not_found', 'message': 'TEST-PRIMARY'}})])
    with pytest.raises(processor.ProcessingError, match='model_not_found') as error:
        processor.Provider().call('Generate', 'source', processor.SCHEMA)
    assert 'TEST-PRIMARY' not in str(error.value)
    assert len(seen) == 1

def test_schema_recovery_keeps_unknown_usage_unknown(monkeypatch):
    schema_recovery_client(monkeypatch, [(400, {'error': {'code': 'json_validate_failed'}}), (200, valid_response())])
    p = processor.Provider()
    p.call('Generate', 'source', processor.SCHEMA)
    assert p.usage()['inputTokens'] is None

def test_schema_recovery_cannot_exceed_request_budget(monkeypatch):
    monkeypatch.setenv('MAX_AI_CALLS_PER_DOCUMENT', '1')
    seen = schema_recovery_client(monkeypatch, [(400, {'error': {'code': 'json_validate_failed'}})])
    with pytest.raises(processor.ProcessingError, match='request budget'):
        processor.Provider().call('Generate', 'source', processor.SCHEMA)
    assert len(seen) == 1

def gemini_client(monkeypatch, statuses, value=None):
    monkeypatch.setenv('AI_ENABLED', 'true')
    monkeypatch.setenv('LLM_BASE_URL', 'https://api.groq.com/openai/v1')
    monkeypatch.setenv('LLM_MODEL', 'openai/gpt-oss-120b')
    monkeypatch.setenv('LLM_API_KEY', 'TEST-PAID')
    monkeypatch.setenv('LLM_FALLBACK_API_KEY', 'TEST-FREE')
    monkeypatch.setenv('GEMINI_API_KEY', 'TEST-GOOGLE')
    monkeypatch.setenv('GEMINI_MODEL', 'gemini-3.8-flash')
    seen = []
    class Client:
        def __init__(self, **kwargs): pass
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def post(self, url, headers, json):
            seen.append((url, headers['Authorization'], json))
            status = statuses.pop(0)
            return processor.httpx.Response(status, headers={'retry-after':'600'}, json=valid_response(value), request=processor.httpx.Request('POST', url))
    monkeypatch.setattr(processor.httpx, 'Client', Client)
    return seen

def test_gemini_third_fallback_routes_key_model_and_request_separately(monkeypatch):
    seen = gemini_client(monkeypatch, [429, 429, 200, 200])
    p = processor.Provider()
    assert p.call('Generate', 'SOURCE TAIL', processor.SCHEMA)['headline'] == draft()['headline']
    assert [x[1] for x in seen] == ['Bearer TEST-PAID', 'Bearer TEST-FREE', 'Bearer TEST-GOOGLE']
    assert all(x[0].startswith('https://api.groq.com/') for x in seen[:2])
    url, auth, payload = seen[2]
    assert url == 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'
    assert payload['model'] == 'gemini-3.8-flash'
    assert payload['response_format'] == {'type':'json_object'}
    assert payload['reasoning_effort'] == 'low'
    assert 'SOURCE TAIL' in payload['messages'][1]['content']
    assert p.usage()['model'] == 'gemini-3.8-flash'
    assert p.usage()['inputTokens'] == 100
    processor.Provider().call('Generate', 'source', processor.SCHEMA)
    assert seen[-1][1] == 'Bearer TEST-GOOGLE'

def test_gemini_output_still_requires_full_article_schema(monkeypatch):
    gemini_client(monkeypatch, [429, 429, 200], {})
    with pytest.raises(processor.ProcessingError, match='ValidationError'):
        processor.Provider().call('Generate', 'source', processor.SCHEMA)

def test_all_three_rate_limits_respected_without_extra_requests(monkeypatch):
    seen = gemini_client(monkeypatch, [429, 429, 429])
    with pytest.raises(processor.ProcessingError, match='cooling down'):
        processor.Provider().call('Generate', 'source', processor.SCHEMA)
    assert len(seen) == 3

def test_gemini_cost_not_fabricated_from_groq_prices(monkeypatch):
    gemini_client(monkeypatch, [429, 429, 200])
    monkeypatch.setenv('LLM_INPUT_PRICE_PER_MILLION', '2')
    monkeypatch.setenv('LLM_OUTPUT_PRICE_PER_MILLION', '4')
    p = processor.Provider()
    p.call('Generate', 'source', processor.SCHEMA)
    assert p.usage()['estimatedCost'] is None

def test_cost_cap_blocks_unpriced_gemini_before_sending(monkeypatch):
    seen = gemini_client(monkeypatch, [429, 429])
    monkeypatch.setenv('LLM_INPUT_PRICE_PER_MILLION', '2')
    monkeypatch.setenv('LLM_OUTPUT_PRICE_PER_MILLION', '4')
    monkeypatch.setenv('MAX_AI_COST_PER_DOCUMENT', '1')
    with pytest.raises(processor.ProcessingError, match='pricing for the selected fallback'):
        processor.Provider().call('Generate', 'source', processor.SCHEMA)
    assert len(seen) == 2

def test_gemini_uses_its_own_configured_prices(monkeypatch):
    gemini_client(monkeypatch, [429, 429, 200])
    monkeypatch.setenv('LLM_INPUT_PRICE_PER_MILLION', '2')
    monkeypatch.setenv('LLM_OUTPUT_PRICE_PER_MILLION', '4')
    monkeypatch.setenv('GEMINI_INPUT_PRICE_PER_MILLION', '1')
    monkeypatch.setenv('GEMINI_OUTPUT_PRICE_PER_MILLION', '3')
    p = processor.Provider()
    p.call('Generate', 'source', processor.SCHEMA)
    assert p.usage()['estimatedCost'] == pytest.approx(0.00016)

def test_gemini_key_never_appears_in_rate_limit_logs(monkeypatch, capsys):
    gemini_client(monkeypatch, [429, 429, 429])
    with pytest.raises(processor.ProcessingError):
        processor.Provider().call('Generate', 'source', processor.SCHEMA)
    output = capsys.readouterr().out
    assert '"credential": "gemini"' in output
    assert all(key not in output for key in ['TEST-GOOGLE', 'TEST-PAID', 'TEST-FREE'])

def router_client(monkeypatch, statuses, value=None):
    monkeypatch.setenv('OPENROUTER_API_KEY', 'TEST-ROUTER')
    monkeypatch.setenv('OPENROUTER_MODEL', 'openrouter/free')
    return gemini_client(monkeypatch, statuses, value)

def test_openrouter_fourth_routes_only_its_own_key_and_json_mode(monkeypatch):
    seen = router_client(monkeypatch, [429, 429, 429, 200])
    p = processor.Provider()
    p.call('Generate', '[Page 137] preserved', processor.SCHEMA)
    assert len(seen) == 4
    url, auth, payload = seen[-1]
    assert url == 'https://openrouter.ai/api/v1/chat/completions'
    assert auth == 'Bearer TEST-ROUTER'
    assert payload['model'] == 'openrouter/free'
    assert payload['response_format'] == {'type':'json_object'}
    assert payload['provider'] == {'require_parameters':True}
    assert 'reasoning_effort' not in payload
    assert '[Page 137] preserved' in payload['messages'][1]['content']

def test_openrouter_can_work_without_gemini_configured(monkeypatch):
    seen = router_client(monkeypatch, [429, 429, 200])
    monkeypatch.delenv('GEMINI_API_KEY')
    processor.Provider().call('Generate', 'source', processor.SCHEMA)
    assert len(seen) == 3 and seen[-1][1] == 'Bearer TEST-ROUTER'

def test_openrouter_rejects_incomplete_article(monkeypatch):
    router_client(monkeypatch, [429, 429, 429, 200], {})
    with pytest.raises(processor.ProcessingError, match='ValidationError'):
        processor.Provider().call('Generate', 'source', processor.SCHEMA)

def test_openrouter_paid_models_rejected_before_network(monkeypatch):
    seen = router_client(monkeypatch, [])
    monkeypatch.setenv('OPENROUTER_MODEL', 'some-provider/paid-model')
    with pytest.raises(processor.ProcessingError, match='Paid OpenRouter routing is disabled'):
        processor.Provider()
    assert seen == []

def test_explicit_free_model_and_actual_model_usage(monkeypatch):
    router_client(monkeypatch, [])
    monkeypatch.setenv('OPENROUTER_MODEL', 'test/model:free')
    p = processor.Provider()
    assert p.backends[-1]['model'] == 'test/model:free'
    p._record_usage({'model':'test/actual-model:free','usage':{'prompt_tokens':2,'completion_tokens':3}}, 0, p.backends[-1])
    assert p.usage()['model'] == 'test/actual-model:free'

def test_all_four_cooldowns_respected(monkeypatch):
    seen = router_client(monkeypatch, [429, 429, 429, 429])
    with pytest.raises(processor.ProcessingError, match='cooling down'):
        processor.Provider().call('Generate', 'source', processor.SCHEMA)
    assert len(seen) == 4

def output_limit_client(monkeypatch, selected):
    monkeypatch.setenv('AI_ENABLED', 'true')
    monkeypatch.setenv('LLM_BASE_URL', 'https://api.groq.com/openai/v1')
    monkeypatch.setenv('LLM_MODEL', 'openai/gpt-oss-120b')
    monkeypatch.setenv('LLM_API_KEY', 'TEST-PAID')
    monkeypatch.setenv('LLM_FALLBACK_API_KEY', 'TEST-FREE')
    monkeypatch.setenv('GEMINI_API_KEY', 'TEST-GOOGLE')
    monkeypatch.setenv('OPENROUTER_API_KEY', 'TEST-ROUTER')
    used = []
    class Client:
        def __init__(self, **kwargs): pass
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def post(self, url, headers, json):
            used.append(headers['Authorization'])
            if len(used) <= selected:
                return processor.httpx.Response(429, headers={'retry-after':'600'}, request=processor.httpx.Request('POST', url))
            body = valid_response()
            body['choices'][0]['finish_reason'] = 'length'
            body['model'] = 'test/actual-routed-model:free'
            return processor.httpx.Response(200, json=body, request=processor.httpx.Request('POST', url))
    monkeypatch.setattr(processor.httpx, 'Client', Client)
    return used

@pytest.mark.parametrize('index,label,model', [(0,'Groq primary','openai/gpt-oss-120b'),(1,'Groq backup','openai/gpt-oss-120b'),(2,'Google Gemini','gemini-3.8-flash'),(3,'OpenRouter','test/actual-routed-model:free')])
def test_output_limit_names_correct_provider_and_actual_model(monkeypatch, capsys, index, label, model):
    used = output_limit_client(monkeypatch, index)
    monkeypatch.setenv('LLM_MAX_OUTPUT_TOKENS', '3000')
    p = processor.Provider()
    with pytest.raises(processor.ProcessingError) as error:
        p.call('Generate', 'source', processor.SCHEMA)
    assert label in str(error.value) and model in str(error.value)
    assert '3000' in str(error.value) and 'not an account rate limit' in str(error.value)
    assert len(used) == index + 1  # Truncated output must never be accepted or retried as 429.
    assert p.usage()['inputTokens'] == 100
    output = capsys.readouterr().out
    assert 'providerOutputLimit' in output and model in output
    assert all(key not in output for key in ['TEST-PAID','TEST-FREE','TEST-GOOGLE','TEST-ROUTER'])

def test_provider_supplied_model_cannot_leak_key_or_markup(monkeypatch):
    output_limit_client(monkeypatch, 3)
    p = processor.Provider()
    backend = p.backends[-1]
    assert p._model_name({'model':'TEST-ROUTER'}, backend) == 'openrouter/free'
    assert p._model_name({'model':'<script>bad</script>'}, backend) == 'openrouter/free'


def test_rate_limit_log_also_names_requested_model(monkeypatch, capsys):
    used = output_limit_client(monkeypatch, 1)
    with pytest.raises(processor.ProcessingError):
        processor.Provider().call('Generate', 'source', processor.SCHEMA)
    lines = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    rate = next(line for line in lines if line.get('providerRateLimited'))
    assert rate['provider'] == 'Groq primary'
    assert rate['model'] == 'openai/gpt-oss-120b'
