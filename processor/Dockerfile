FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-eng && rm -rf /var/lib/apt/lists/* && useradd --create-home --uid 10001 worker
WORKDIR /app
COPY processor/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY --chown=worker:worker processor ./processor
COPY --chown=worker:worker resources ./resources
USER worker
CMD ["python","processor/worker.py"]
