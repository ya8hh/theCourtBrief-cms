import importlib.util
import os
import sys
import types
from pathlib import Path
import pytest

# Tests never contact AWS or Render.
sys.modules.setdefault('boto3', types.SimpleNamespace(client=lambda name: None))
spec=importlib.util.spec_from_file_location('power_controller', Path(__file__).parents[1]/'controller.py')
c=importlib.util.module_from_spec(spec); spec.loader.exec_module(c)

class EC2:
    def __init__(self, state): self.state=state; self.actions=[]
    def describe_instances(self, **kwargs): return {'Reservations':[{'Instances':[{'State':{'Name':self.state}}]}]}
    def start_instances(self, **kwargs): self.actions.append('start')
    def stop_instances(self, **kwargs): self.actions.append('stop')

@pytest.mark.parametrize('state,busy,expected', [('stopped',True,'start'),('running',True,None),('stopped',False,None),('running',False,'stop'),('pending',True,None),('stopping',True,None)])
def test_lifecycle(monkeypatch,state,busy,expected):
    ec2=EC2(state); actions=[]
    monkeypatch.setenv('INSTANCE_ID','i-test-only')
    monkeypatch.setattr(c.boto3,'client',lambda name:ec2)
    def cms(action):
        actions.append(action)
        return dict(busy=busy,mode='draining' if action=='drain' else 'active',canStop=not busy and action=='drain')
    monkeypatch.setattr(c,'cms',cms)
    c.handler({},None)
    assert ec2.actions==([expected] if expected else [])
    if busy and state in ('running','stopped'): assert actions==['inspect','resume']

def test_new_job_between_inspect_and_drain_prevents_stop(monkeypatch):
    ec2=EC2('running'); monkeypatch.setenv('INSTANCE_ID','i-test-only')
    monkeypatch.setattr(c.boto3,'client',lambda name:ec2)
    monkeypatch.setattr(c,'cms',lambda action:dict(busy=action=='drain',mode='active',canStop=False))
    c.handler({},None); assert ec2.actions==[]

def test_cms_failure_never_stops_worker(monkeypatch):
    ec2=EC2('running'); monkeypatch.setenv('INSTANCE_ID','i-test-only')
    monkeypatch.setattr(c.boto3,'client',lambda name:ec2)
    def fail(action): raise TimeoutError('TEST ONLY')
    monkeypatch.setattr(c,'cms',fail)
    with pytest.raises(TimeoutError): c.handler({},None)
    assert ec2.actions==[]


def test_inconsistent_cms_response_cannot_authorize_stop(monkeypatch):
    ec2=EC2('running'); monkeypatch.setenv('INSTANCE_ID','i-test-only')
    monkeypatch.setattr(c.boto3,'client',lambda name:ec2)
    monkeypatch.setattr(c,'cms',lambda action:dict(busy=action=='drain',mode='draining',canStop=True))
    c.handler({},None); assert ec2.actions==[]
