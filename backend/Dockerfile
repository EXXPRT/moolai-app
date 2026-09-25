FROM python:3.13.5-slim
WORKDIR /app
COPY requirements.txt constraints.txt ./
RUN pip install --no-cache-dir -r requirements.txt -c constraints.txt
COPY moolai_backend ./moolai_backend
RUN useradd --create-home app
USER app
EXPOSE 8000
CMD ["uvicorn", "moolai_backend.app:app", "--host", "0.0.0.0", "--port", "8000", "--no-access-log"]
