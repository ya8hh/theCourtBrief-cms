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
