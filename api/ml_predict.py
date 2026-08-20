"""
api/ml_predict.py
=================
Vercel Python Serverless Function entry point for ML Model Prediction ONLY.

Endpoints:
    GET  /api/py/predict  -> Health check
    POST /api/py/predict  -> Authenticated prediction execution

Security:
    Enforces exact match of the 'x-ml-secret' header with os.environ['ML_SERVICE_SECRET'].
"""

import base64
import io
import json
import os
import sys
import traceback
from http.server import BaseHTTPRequestHandler

import joblib

# Add repository root to sys.path so ml modules are importable
ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT_DIR not in sys.path:
    sys.path.insert(0, ROOT_DIR)

from ml.predict import PredictionError, predict, predict_from_artifact


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
            "service": "kindercura-ml-predict",
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

        data = payload.get("data")
        if data is None:
            self._send_json(400, {
                "success": False,
                "error": "Missing required field 'data'",
            })
            return

        model_artifact_base64 = payload.get("model_artifact_base64")
        model_path = payload.get("model_path")

        if not model_artifact_base64 and not model_path:
            self._send_json(400, {
                "success": False,
                "error": "Either 'model_artifact_base64' or 'model_path' is required",
            })
            return

        # 3. Execute prediction
        try:
            if model_artifact_base64:
                raw_artifact_bytes = base64.b64decode(model_artifact_base64)
                artifact = joblib.load(io.BytesIO(raw_artifact_bytes))
                result = predict_from_artifact(artifact, data)
            else:
                if not os.path.exists(model_path):
                    self._send_json(404, {
                        "success": False,
                        "error": f"Model file not found: {model_path}",
                    })
                    return
                result = predict(model_path, data)

            self._send_json(200, result)

        except PredictionError as err:
            self._send_json(400, {
                "success": False,
                "error": str(err),
            })
        except Exception as exc:
            self._send_json(500, {
                "success": False,
                "error": f"Prediction failed: {exc}",
                "traceback": traceback.format_exc(),
            })
