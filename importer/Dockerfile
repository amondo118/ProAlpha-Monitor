FROM python:3.13-alpine
WORKDIR /app
# Time zone data, so TZ (compose.yaml) gives local times in the log
RUN apk add --no-cache tzdata
# Standard library only for now. When a real parser needs packages,
# add a requirements.txt and: RUN pip install --no-cache-dir -r requirements.txt
COPY *.py ./
ENV PYTHONUNBUFFERED=1
CMD ["python", "importer.py"]
