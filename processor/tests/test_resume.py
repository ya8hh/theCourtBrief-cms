import copy
import hashlib
import json
import os
import sys
from pathlib import Path
import pytest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import processor
from checkpoint import CheckpointProvider
from test_processor import draft

class CountingProvider:
    seen = []
    block_once = False
    def __init__(self, **kwargs):
        self.calls=0; self.input_tokens=0; self.output_tokens=0; self.tokens_known=True
        self.cost=0; self.cost_known=False; self.models_used=[]
    def call(self, task, source, schema=None):
        self.calls+=1
        self.seen.append((task, source))
        if self.block_once and self.calls == 4:
            CountingProvider.block_once=False
            raise processor.RateLimitWait(600)
        self.input_tokens+=10; self.output_tokens+=2
        if task.startswith('Compress these internal'): return {'notes':'TEST ONLY compact holding p1; exceptions retained'}
        if schema: return draft()
        if task.startswith('Check'): return {'warnings':[]}
        return {'verifiedFacts':['TEST ONLY compact source notes'], 'pageReferences':[]}
    def usage(self):
        return {'model':'TEST-ONLY','inputTokens':self.input_tokens,'outputTokens':self.output_tokens,'requests':self.calls,'estimatedCost':None}

@pytest.fixture(autouse=True)
def clean(monkeypatch):
    processor._KEY_COOLDOWNS.clear()
    CountingProvider.seen=[]; CountingProvider.block_once=False
    monkeypatch.setenv('LLM_CONTEXT_BYTES','26000')
    monkeypatch.setenv('LLM_MAX_OUTPUT_TOKENS','3000')
    yield
    processor._KEY_COOLDOWNS.clear()

def test_500_pages_resume_skips_saved_calls_and_checks_every_source_chunk(monkeypatch):
    monkeypatch.setattr(processor,'Provider',CountingProvider)
    text='\n'.join(f'[Page {i}]\n'+('TEST ONLY source text. '*90)+f' TAIL-PAGE-{i}' for i in range(1,501))
    extraction={'text':text}; saved=[]
    CountingProvider.block_once=True
    with pytest.raises(processor.RateLimitWait) as waiting:
        processor.generate(extraction,{},save_checkpoint=lambda state:saved.append(copy.deepcopy(state)),credentials_loader=lambda:{'managed':False})
    state=waiting.value.checkpoint
    assert len(state['entries']) == 3
    completed = list(CountingProvider.seen[:3])
    assert state['runtime']['calls']==4
    result=processor.generate(extraction,{},checkpoint=state,save_checkpoint=lambda state:saved.append(copy.deepcopy(state)),credentials_loader=lambda:{'managed':False})
    assert result['draft']['headline']==draft()['headline']
    for call in completed:
        assert CountingProvider.seen.count(call)==1
    checks=[source for task,source in CountingProvider.seen if task.startswith('Check')]
    assert all(any(f'TAIL-PAGE-{page}' in source for source in checks) for page in range(1,501))
    assert saved[-1]['progress']['phase']=='Complete'
    assert saved[-1]['progress']['completed']==saved[-1]['progress']['total']
    assert any(s['progress'].get('reusedSteps',0)>0 for s in saved)

def test_cache_invalidates_on_source_instruction_but_preserves_valid_analysis_after_output_tuning(monkeypatch):
    provider=CountingProvider(); saves=[]
    first=CheckpointProvider(provider,{'text':'original'},{},'',None,None,saves.append)
    first.set_progress('Test',1);first.call('task','source')
    saved=first.capture()
    for text,instruction in [('changed',''),('original','new instruction')]:
        current=CheckpointProvider(CountingProvider(),{'text':text},{},instruction,None,saved,lambda _:None)
        assert current.state['entries']=={}
    monkeypatch.setenv('LLM_MAX_OUTPUT_TOKENS','4000')
    assert CheckpointProvider(CountingProvider(),{'text':'original'},{},'',None,saved,lambda _:None).state['entries']==saved['entries']
    monkeypatch.setenv('LLM_CONTEXT_BYTES','32000')
    assert not CheckpointProvider(CountingProvider(),{'text':'original'},{},'',None,saved,lambda _:None).state['entries']

def test_cached_invalid_article_is_not_accepted():
    saved=[]; wrapper=CheckpointProvider(CountingProvider(),{'text':'source'},{},'',None,None,saved.append)
    wrapper.set_progress('Draft',1)
    ident=hashlib.sha256(json.dumps(['task','source',processor.SCHEMA],sort_keys=True,separators=(',',':')).encode()).hexdigest()
    wrapper.state['entries'][ident]={}
    with pytest.raises(Exception):wrapper.call('task','source',processor.SCHEMA)

def test_managed_credentials_replace_environment_and_reload(monkeypatch):
    monkeypatch.setenv('AI_ENABLED','true');monkeypatch.setenv('LLM_MODEL','test');monkeypatch.setenv('LLM_API_KEY','ENV-OLD-KEY')
    config={'managed':True,'credentials':[{'id':'cms-key','provider':'groq','model':'openai/gpt-oss-120b','apiKey':'CMS-NEW-KEY','baseUrl':'https://api.groq.com/openai/v1','inputPrice':None,'outputPrice':None}]}
    p=processor.Provider(credentials_loader=lambda:config,defer_on_limit=True)
    assert [b['key'] for b in p.backends]==['CMS-NEW-KEY']
    config['credentials']=[];p.refresh_credentials()
    assert p.backends==[]
    with pytest.raises(processor.RateLimitWait,match='No enabled AI credentials') as wait:p.call('task','source')
    assert wait.value.reason=='no_credentials'

def test_managed_cooldowns_survive_worker_restart(monkeypatch):
    monkeypatch.setenv('AI_ENABLED','true')
    monkeypatch.delenv('LLM_API_KEY',raising=False);monkeypatch.delenv('LLM_MODEL',raising=False)
    config={'managed':True,'credentials':[{'id':'cms-key','provider':'groq','model':'test','apiKey':'CMS-KEY-ONLY','baseUrl':'https://api.groq.com/openai/v1','cooldownUntil':processor.time.time()+600}]}
    p=processor.Provider(credentials_loader=lambda:config,defer_on_limit=True)
    with pytest.raises(processor.RateLimitWait) as wait:p.call('task','source')
    assert wait.value.retry_after>590
    assert wait.value.cooldowns[0]['id']=='cms-key'
    assert p.calls==0

def test_unexpected_cms_endpoint_rejected_before_key_can_be_sent(monkeypatch):
    monkeypatch.setenv('AI_ENABLED','true')
    with pytest.raises(processor.ProcessingError,match='invalid provider'):
        processor.Provider(credentials_loader=lambda:{'managed':True,'credentials':[{'provider':'groq','baseUrl':'https://evil.test','apiKey':'CMS-KEY-ONLY'}]})


def test_checkpoint_has_no_credentials(monkeypatch):
    monkeypatch.setenv('AI_ENABLED','true');monkeypatch.setenv('LLM_API_KEY','SECRET-NOT-FOR-CHECKPOINT');monkeypatch.setenv('LLM_MODEL','test')
    p=processor.Provider()
    state=CheckpointProvider(p,{'text':'source'},{},'',None,None,lambda _:None).capture()
    assert 'SECRET-NOT-FOR-CHECKPOINT' not in json.dumps(state)
    assert 'apiKey' not in json.dumps(state)


def test_many_routed_models_keep_cms_model_metadata_within_column_limit(monkeypatch):
    monkeypatch.setenv('AI_ENABLED','true');monkeypatch.setenv('LLM_MODEL','test');monkeypatch.setenv('LLM_API_KEY','TEST-ONLY-KEY')
    p=processor.Provider()
    p.models_used=['test/' + ('model-name-'*8) + str(i) for i in range(20)]
    assert len(p.usage()['model'])<=200
    assert len(p.usage()['modelsUsed'])==20


def test_cached_replay_avoids_per_section_database_writes():
    writes=[];first=CheckpointProvider(CountingProvider(),{'text':'source'},{},'',None,None,writes.append)
    for i in range(30):
        first.set_progress('Analysis',30,i);first.call('task'+str(i),'source')
    writes.clear();restarted=CheckpointProvider(CountingProvider(),{'text':'source'},{},'',None,first.capture(),writes.append)
    for i in range(30):
        restarted.set_progress('Analysis',30,i);restarted.call('task'+str(i),'source')
    assert not writes
    restarted.set_progress('Complete',30,30)
    assert len(writes)==1 and writes[0]['progress']['reusedSteps']==30
