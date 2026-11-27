FROM python:3.13-alpine
WORKDIR /app
# No RUN step that downloads anything: the build works even where containers
# can't reach DNS or the internet (only the base image is pulled, by the host).
# Local time in the log comes from the host's /etc/localtime (compose.yaml).
# Standard library only for now. When a real parser needs packages,
# add a requirements.txt and: RUN pip install --no-cache-dir -r requirements.txt
COPY *.py ./
ENV PYTHONUNBUFFERED=1
CMD ["python", "importer.py"]
