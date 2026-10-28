FROM python:3.12-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY panel/app ./app
COPY agent ./agent
COPY scripts ./scripts

ENV DATABASE_URL=sqlite:////data/tunnel-panel.db
VOLUME ["/data"]
EXPOSE 8080

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
