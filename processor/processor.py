"""Bounded PDF extraction and grounded, explicitly enabled AI generation."""
from __future__ import annotations
import os, json, re, hashlib, subprocess, sys, tempfile, time
from pathlib import Path
import httpx, jsonschema
ROOT = Path(__file__).resolve().parents[1]
SCHEMA = json.loads((ROOT / 'resources/article.schema.json').read_text())
PROMPT = (ROOT / 'resources/article-prompt.txt').read_text()

class ProcessingError(Exception):
    pass

def extract_bytes(data: bytes) -> dict:
    import pymupdf
    if len(data) > int(os.getenv('MAX_UPLOAD_BYTES', '26214400')) or not data.startswith(b'%PDF-'):
        raise ProcessingError('Invalid PDF signature or upload size.')
    try:
        document = pymupdf.open(stream=data, filetype='pdf')
    except Exception as exc:
        raise ProcessingError('The PDF is corrupted or unreadable.') from exc
    with document:
        if document.needs_pass:
            raise ProcessingError('Password-protected PDFs are not supported. Upload an unlocked official copy.')
        if len(document) > int(os.getenv('MAX_PDF_PAGES', '1000')):
            raise ProcessingError('PDF exceeds the configured page limit.')
        pages, warnings, scanned = [], [], []
        size = 0
        for index, page in enumerate(document):
            text = page.get_text('text', sort=True).strip()
            ocr = False
            if len(text) < 40:
                scanned.append(index + 1)
                if os.getenv('OCR_ENABLED', 'false').lower() == 'true':
                    try:
                        tp = page.get_textpage_ocr(language=os.getenv('OCR_LANGUAGE', 'eng'), dpi=150, full=True)
                        text = page.get_text(textpage=tp).strip()
                        ocr = len(text) >= 40
                    except Exception:
                        warnings.append(f'OCR failed on page {index+1}; manual review required.')
            size += len(text)
            if size > int(os.getenv('MAX_EXTRACTED_CHARS', '10000000')):
                raise ProcessingError('Extracted text exceeds the storage limit. Split the document explicitly; no text was silently truncated.')
            pages.append({'page': index + 1, 'text': text, 'ocr': ocr})
        unresolved = [p['page'] for p in pages if len(p['text']) < 40]
        if unresolved:
            warnings.append('Scanned, blank or unreadable pages require review: ' + ', '.join(map(str, unresolved)))
        text = '\n\n'.join(f'[Page {p["page"]}]\n{p["text"]}' for p in pages)
        return {'text': text, 'pages': pages, 'pageCount': len(pages), 'ocrRequired': bool(unresolved), 'scannedPages': scanned, 'warnings': warnings, 'sha256': hashlib.sha256(data).hexdigest()}

def extract_isolated(data: bytes) -> dict:
    # Parse in a disposable child. Embedded scripts/links are never executed or fetched.
    with tempfile.TemporaryDirectory(prefix='court-extract-') as folder:
        source, result = Path(folder)/'source.pdf', Path(folder)/'result.json'
        source.write_bytes(data)
        child = subprocess.run([sys.executable, str(Path(__file__).resolve()), '--extract', str(source), str(result)], capture_output=True, timeout=int(os.getenv('EXTRACTION_TIMEOUT_SECONDS', '120')))
        if child.returncode or not result.exists():
            raise ProcessingError(child.stderr.decode()[-1000:] or 'Extraction failed or exceeded resource limits.')
        return json.loads(result.read_text())

class Provider:
    def __init__(self):
        if os.getenv('AI_ENABLED', 'false').lower() != 'true':
            raise ProcessingError('External AI is disabled. Manual article creation remains available.')
        self.model, self.key = os.getenv('LLM_MODEL'), os.getenv('LLM_API_KEY')
        self.url = os.getenv('LLM_BASE_URL', 'https://api.openai.com/v1').rstrip('/')
        test = os.getenv('PROCESSOR_TEST_MODE') == '1' and os.getenv('NODE_ENV') == 'test'
        if not self.url.startswith('https://') and not (test and self.url.startswith('http://127.0.0.1:')):
            raise ProcessingError('The configured provider must use HTTPS.')
        if not self.model or not self.key:
            raise ProcessingError('Configure LLM_MODEL and LLM_API_KEY before generating drafts.')
        self.input_tokens = self.output_tokens = 0
        self.tokens_known = True
        self.cost = 0.0
        self.input_price, self.output_price = os.getenv('LLM_INPUT_PRICE_PER_MILLION') or None, os.getenv('LLM_OUTPUT_PRICE_PER_MILLION') or None
        self.priced = self.input_price is not None and self.output_price is not None
        self.cap = float(os.getenv('MAX_AI_COST_PER_DOCUMENT', '0'))
        if self.cap and not self.priced:
            raise ProcessingError('A cost cap requires current input and output pricing configuration.')
        self.calls = 0

    def call(self, task: str, source: str, schema: dict | None = None) -> dict:
        self.calls += 1
        if self.calls > int(os.getenv('MAX_AI_CALLS_PER_DOCUMENT', '100')):
            raise ProcessingError('Document exceeds the configured AI request budget.')
        max_output = int(os.getenv('LLM_MAX_OUTPUT_TOKENS', '3000'))
        if len((PROMPT+task+source).encode()) > int(os.getenv('LLM_CONTEXT_BYTES','64000')):
            raise ProcessingError('Request exceeds the configured context budget. No source was truncated.')
        # Byte length is a deliberately conservative token upper bound.
        reserve = (len((PROMPT+task+source).encode()) * float(self.input_price or 0) + max_output * float(self.output_price or 0)) / 1_000_000
        if self.cap and self.cost + reserve > self.cap:
            raise ProcessingError('Generation would exceed the configured per-document cost cap.')
        response_format = {'type':'json_schema','json_schema':{'name':'court_draft','strict':True,'schema':schema}} if schema else {'type':'json_object'}
        payload = {'model':self.model,'temperature':0.1,'max_tokens':max_output,'response_format':response_format,'messages':[{'role':'system','content':PROMPT+'\n'+task},{'role':'user','content':'BEGIN UNTRUSTED COURT SOURCE\n'+source+'\nEND SOURCE'}]}
        if self.url.startswith('https://api.groq.com/') and self.model.startswith('openai/gpt-oss-'):
            payload['reasoning_effort'] = 'low'
        try:
            with httpx.Client(timeout=float(os.getenv('LLM_TIMEOUT_SECONDS','90'))) as client:
                for attempt in range(5):
                    if attempt:
                        self.calls += 1
                        if self.calls > int(os.getenv('MAX_AI_CALLS_PER_DOCUMENT', '100')):
                            raise ProcessingError('Document exceeds the configured AI request budget.')
                    response = client.post(self.url+'/chat/completions', headers={'Authorization':'Bearer '+self.key}, json=payload)
                    if response.status_code != 429 or attempt == 4:
                        break
                    try:
                        delay = float(response.headers.get('retry-after', '60'))
                    except ValueError:
                        delay = 60
                    time.sleep(max(1, min(delay + 1, 90)))
                response.raise_for_status()
                body = response.json()
            usage = body.get('usage') or {}
            if 'prompt_tokens' in usage and 'completion_tokens' in usage:
                self.input_tokens += usage['prompt_tokens']; self.output_tokens += usage['completion_tokens']
                if self.priced:
                    self.cost += (usage['prompt_tokens']*float(self.input_price)+usage['completion_tokens']*float(self.output_price))/1_000_000
            else:
                self.tokens_known = False
                if self.cap:
                    self.cost += reserve
            if body['choices'][0].get('finish_reason') == 'length':
                raise ProcessingError('The provider output hit its token limit. Increase the output budget and retry.')
            data = json.loads(body['choices'][0]['message']['content'])
            if schema:
                jsonschema.validate(data,schema)
            return data
        except httpx.HTTPStatusError as exc:
            status = exc.response.status_code
            hint = {401: 'The AI API key was rejected. Check the local provider configuration.', 403: 'The configured model is not permitted for this AI account.', 429: 'The AI provider rate limit or account quota was reached. Wait and retry.'}.get(status, f'The AI provider returned HTTP {status}. Check model compatibility and provider availability.')
            raise ProcessingError(hint + ' The original PDF and editor draft are unchanged.') from exc
        except (httpx.HTTPError, KeyError, json.JSONDecodeError, jsonschema.ValidationError) as exc:
            raise ProcessingError(f'AI request or output validation failed ({type(exc).__name__}). The original document and editor draft are unchanged.') from exc

    def usage(self):
        return {'model':self.model,'inputTokens':self.input_tokens if self.tokens_known else None,'outputTokens':self.output_tokens if self.tokens_known else None,'estimatedCost':self.cost if self.priced and self.tokens_known else None,'currency':os.getenv('LLM_PRICE_CURRENCY','USD'),'requests':self.calls}

def chunks(text: str, budget: int):
    if budget < 1000:
        raise ProcessingError('Context budget must be at least 1000 bytes.')
    current = ''
    for line in text.splitlines(keepends=True):
        while len(line.encode()) > budget:
            # Split on characters. Generation supplies the starting page for continuation chunks.
            cut = max(1, budget//4)
            part, line = line[:cut], line[cut:]
            if current:
                yield current; current=''
            yield part
        if len((current+line).encode()) > budget:
            yield current; current=''
        current += line
    if current:
        yield current

def generate(extraction: dict, metadata: dict, instruction: str = '', prior: dict | None = None) -> dict:
    if extraction.get('ocrRequired') or len(extraction.get('text','').strip()) < 100:
        raise ProcessingError('Review the extracted text and resolve OCR or insufficient text before AI generation.')
    provider = Provider()
    try:
        return _generate(provider, extraction, metadata, instruction, prior)
    except Exception as exc:
        exc.usage = provider.usage()
        raise

def _generate(provider, extraction, metadata, instruction, prior):
    budget = int(os.getenv('LLM_CONTEXT_BYTES','64000')) - len((PROMPT+json.dumps(metadata)+json.dumps(prior or {})).encode()) - int(os.getenv('LLM_MAX_OUTPUT_TOKENS','3000'))*4 - 4000
    if budget < 1000: raise ProcessingError('Context budget is too small for the prompt, existing draft and output reserve.')
    source = extraction['text']
    parts = list(chunks(source, budget))
    analysis = []
    page=1
    starts=[]
    for part in parts:
        starts.append(page)
        labels=re.findall(r'\[Page (\d+)\]',part)
        if labels:page=int(labels[-1])
    if len(parts)>1:
        for i, part in enumerate(parts):
            analysis.append(json.dumps(provider.call(f'Analyze chunk {i+1}/{len(parts)}, beginning on source page {starts[i]} (explicit page labels override). Return compact JSON notes with verifiedFacts, reasoning, submissions, operativeOutcome, pageReferences, uncertainties. These are internal notes, not an article. Use at most 180 words total. Keep only newsworthy facts, operative directions and material legal qualifications; omit appearances, repeated facts and routine boilerplate. Attach page references. Never infer missing sections.',part)))
        # Hierarchical reduction preserves every chunk, rather than truncating the tail.
        combined='\n'.join(analysis)
        for level in range(8):
            if len(combined.encode())<=budget:break
            reduced=[json.dumps(provider.call('Compress these internal case-analysis notes to at most 180 words total and less than half the input length. Deduplicate facts. Preserve operative holdings, outcomes, dissent, material qualifications and page references; flag contradictions. Return compact JSON, not an article.',p)) for p in chunks(combined,budget)]
            newer='\n'.join(reduced)
            if len(newer.encode())>=len(combined.encode()):
                raise ProcessingError('Hierarchical analysis did not fit the context budget. Raise the budget or review the document in sections.')
            combined=newer
        if len(combined.encode())>budget:raise ProcessingError('Analysis exceeds context budget; no content was dropped.')
        source=combined
    task='Generate a complete grounded article draft. Metadata provided by editor (verify against source): '+json.dumps(metadata)
    if instruction:
        task += '\nRevision instruction: '+instruction+'\nReturn a full proposed draft; retain unchanged fields.'
    if prior:
        serialized=json.dumps(prior)
        if len(serialized.encode())>budget:raise ProcessingError('Existing draft exceeds revision context budget; use a selected section or raise the budget.')
        task+='\nExisting editor draft: '+serialized
    draft=provider.call(task,source,SCHEMA)
    warnings=list(extraction.get('warnings',[]))
    if not metadata.get('officialSourceUrl'):warnings.append('Missing official source URL; required before publication.')
    if not metadata.get('hasOriginalPdf'):warnings.append('Original PDF attachment must be confirmed before publication.')
    if len(extraction['text'])<500:warnings.append('Source is unusually short; check for missing pages or extraction errors.')
    if metadata.get('judgmentDate') and draft.get('judgmentDate') and metadata['judgmentDate']!=draft['judgmentDate']:
        warnings.append('Case date contradicts the editor metadata; compare the operative document date.')
    for k in ['headline','summary','articleBody','finalOutcome']:
        if not draft.get(k):warnings.append(f'Missing {k}; editor verification required.')
    if draft.get('judgmentDate') and not re.fullmatch(r'\d{4}-\d{2}-\d{2}',draft['judgmentDate']):warnings.append('Invalid judgment date; verify before publication.')
    for k in ['caseTitle','caseNumber','bench']:
        value=draft.get(k)
        if value and re.sub(r'\s+',' ',value).casefold() not in re.sub(r'\s+',' ',extraction['text']).casefold():warnings.append(f'{k} is not an exact match in extracted text; verify manually.')
    for ref in draft['importantParagraphReferences']:
        for number in re.findall(r'\d+',ref):
            page_ref='page' in ref.casefold()
            pattern=rf'\[Page {re.escape(number)}\]' if page_ref else rf'(?m)^\s*\(?{re.escape(number)}[.)]'
            if not re.search(pattern,extraction['text']):warnings.append(f'Unverified paragraph/page reference: {ref}')
    normalized=re.sub(r'\s+',' ',extraction['text']).casefold()
    for quote in re.findall(r'[“\"]([^“”\"\n]{20,})[”\"]',draft.get('articleBody') or ''):
        if re.sub(r'\s+',' ',quote).casefold() not in normalized:warnings.append('A quotation is not an exact match in extracted text; verify the original PDF.')
    # Independent final grounding pass always sees every source chunk, including long PDFs.
    for i,part in enumerate(parts):
        check=provider.call(f'Check the proposed draft against source chunk {i+1}/{len(parts)}, beginning on source page {starts[i]} (explicit page labels override). Return JSON {{"warnings":[]}} for unsupported/contradictory material in this chunk. Absence from this chunk alone is not proof of fabrication. Proposed draft: '+json.dumps(draft),part)
        if not isinstance(check.get('warnings'),list) or any(not isinstance(w,str) for w in check['warnings']):
            raise ProcessingError('Grounding checker returned an invalid warnings list.')
        warnings.extend(check['warnings'])
    return {'draft':draft,'accuracyWarnings':list(dict.fromkeys(warnings)),'promptVersion':'v1','usage':provider.usage()}

if __name__ == '__main__' and len(sys.argv)>1 and sys.argv[1]=='--extract':
    try:
        if sys.platform=='linux':
            import resource
            resource.setrlimit(resource.RLIMIT_AS,(int(os.getenv('EXTRACTION_MEMORY_MB','1024'))*1024**2,)*2)
            resource.setrlimit(resource.RLIMIT_CPU,(int(os.getenv('EXTRACTION_TIMEOUT_SECONDS','120')),)*2)
        result=extract_bytes(Path(sys.argv[2]).read_bytes())
        Path(sys.argv[3]).write_text(json.dumps(result))
    except Exception as error:
        print(str(error),file=sys.stderr);sys.exit(1)
