"""
api/ml_train.py
===============
Vercel Python Serverless Function entry point for ML Model Training ONLY.

Endpoints:
    GET  /api/py/train  -> Health check
    POST /api/py/train  -> Authenticated training execution

Security:
    Enforces exact match of the 'x-ml-secret' header with os.environ['ML_SERVICE_SECRET'].
"""

import base64
import json
import os
import sys
import traceback
from http.server import BaseHTTPRequestHandler

# Add repository root to sys.path so ml modules are importable
ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT_DIR not in sys.path:
    sys.path.insert(0, ROOT_DIR)

from ml.trainer import (
    FEATURE_SET_SCORE,
    VALID_FEATURE_SETS,
    TrainingError,
    train_dataset_content,
)


class handler(BaseHTTPRequestHandler):
    def _send_json(self, status_code: int, data: dict):
        response_bytes = json.dumps(data).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(response_bytes)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, x-ml-secret")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()
        self.wfile.write(response_bytes)

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, x-ml-secret")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()

    def do_GET(self):
        # Health check endpoint
        self._send_json(200, {
            "ok": True,
            "service": "kindercura-ml-train",
            "status": "ready",
            "python": sys.version,
        })

    def do_POST(self):
        # 1. Strict authentication check
        expected_secret = os.environ.get("ML_SERVICE_SECRET")
        provided_secret = self.headers.get("x-ml-secret")

        if not expected_secret or provided_secret != expected_secret:
            self._send_json(401, {
                "success": False,
                "error": "Unauthorized: invalid or missing ML_SERVICE_SECRET",
            })
            return

        # 2. Read request body
        try:
            content_length = int(self.headers.get("Content-Length", 0))
            if content_length <= 0:
                self._send_json(400, {
                    "success": False,
                    "error": "Empty request body",
                })
                return
            body_bytes = self.rfile.read(content_length)
            payload = json.loads(body_bytes.decode("utf-8"))
        except Exception as exc:
            self._send_json(400, {
                "success": False,
                "error": f"Invalid JSON payload: {exc}",
            })
            return

        dataset_content = payload.get("dataset_content")
        if not dataset_content:
            self._send_json(400, {
                "success": False,
                "error": "Missing required field 'dataset_content'",
            })
            return

        file_type = payload.get("file_type", "csv")
        feature_set = payload.get("feature_set", FEATURE_SET_SCORE)
        output_dir = payload.get("output_dir", "/tmp/models")

        # 3. Execute training
        try:
            result = train_dataset_content(
                content=dataset_content,
                file_type=file_type,
                output_dir=output_dir,
                feature_set=feature_set,
            )

            # 4. Read model artifact and encode as base64
            model_path = result.get("model_path")
            if model_path and os.path.exists(model_path):
                with open(model_path, "rb") as f:
                    artifact_bytes = f.read()
                result["model_artifact_base64"] = base64.b64encode(artifact_bytes).decode("utf-8")
                result["artifact_size_bytes"] = len(artifact_bytes)

            self._send_json(200, result)

        except TrainingError as err:
            self._send_json(400, {
                "success": False,
                "error": str(err),
            })
        except Exception as exc:
            self._send_json(500, {
                "success": False,
                "error": f"Training failed: {exc}",
                "traceback": traceback.format_exc(),
            })
