"""Lease-fenced CMS checkpoints for deterministic generation steps. No provider keys."""
import copy
import hashlib
import json
import os
import time
import jsonschema

class CheckpointProvider:
    def __init__(self, provider, extraction, metadata, instruction, prior, saved, persist):
        from processor import PROMPT, SCHEMA, _KEY_COOLDOWNS
        contract = dict(version='resumable-v1', source=hashlib.sha256(extraction['text'].encode()).hexdigest(),
                        metadata=metadata, instruction=instruction, prior=prior,
                        prompt=PROMPT, schema=SCHEMA, context=os.getenv('LLM_CONTEXT_BYTES','64000'))
        fingerprint = hashlib.sha256(json.dumps(contract,sort_keys=True,separators=(',',':')).encode()).hexdigest()
        self.provider, self.persist = provider, persist
        self.replayed = 0
        if isinstance(saved,dict) and saved.get('version') == 1 and saved.get('fingerprint') == fingerprint:
            self.state = copy.deepcopy(saved)
        else:
            self.state = dict(version=1,fingerprint=fingerprint,entries={},progress={},runtime={})
        if not isinstance(self.state.get('entries'),dict):
            raise ValueError('Invalid saved checkpoint entries.')
        runtime = self.state.get('runtime') or {}
        for field in ['calls','input_tokens','output_tokens','tokens_known','cost','cost_known','models_used']:
            if field in runtime:
                setattr(provider, field, copy.deepcopy(runtime[field]))
        for ident, until in runtime.get('cooldowns',{}).items():
            remaining = float(until)-time.time()
            if remaining>0:
                _KEY_COOLDOWNS[ident] = max(_KEY_COOLDOWNS.get(ident,0),time.monotonic()+remaining)

    def capture(self):
        from processor import _KEY_COOLDOWNS
        runtime = {field:copy.deepcopy(getattr(self.provider,field)) for field in
                   ['calls','input_tokens','output_tokens','tokens_known','cost','cost_known','models_used'] if hasattr(self.provider,field)}
        runtime['cooldowns'] = {ident:time.time()+deadline-time.monotonic() for ident,deadline in _KEY_COOLDOWNS.items() if deadline>time.monotonic()}
        self.state['runtime'] = runtime
        if len(json.dumps(self.state).encode())>8*1024*1024:
            raise ValueError('Saved analysis exceeds the checkpoint size limit; no source text was truncated.')
        return copy.deepcopy(self.state)

    def plan_budget(self, proposed):
        # Output-token tuning must not throw away valid completed section analysis.
        if 'planBudget' not in self.state:
            self.state['planBudget'] = proposed
        return self.state['planBudget']

    def set_progress(self, phase, total, completed=0):
        self.state['progress'] = dict(phase=phase,total=total,completed=completed,waiting=False,cached=False,reusedSteps=self.replayed)
        if not self.state['entries'] or phase == 'Complete':
            self.persist(self.capture())

    def call(self, task, source, schema=None):
        ident = hashlib.sha256(json.dumps([task,source,schema],sort_keys=True,separators=(',',':')).encode()).hexdigest()
        entries = self.state['entries']
        cached = ident in entries
        if cached:
            self.replayed += 1
            value = copy.deepcopy(entries[ident])
            if schema:
                jsonschema.validate(value,schema)
        else:
            value = self.provider.call(task,source,schema)
            if len(entries)>=5000:
                raise ValueError('Generation exceeds the checkpoint step limit.')
            entries[ident] = copy.deepcopy(value)
        progress = self.state.setdefault('progress',{})
        progress['completed'] = min(progress.get('completed',0)+1,progress.get('total',1))
        progress['cached'] = cached
        progress['reusedSteps'] = self.replayed
        if not cached:
            self.persist(self.capture())
        return value

    def usage(self):
        return self.provider.usage()
