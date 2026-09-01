#!/usr/bin/env python3
"""
AgroRover Dashboard — Startup Script
Checks dependencies, optionally starts MongoDB, then launches Flask.
"""
import subprocess, sys, os, time, webbrowser

ROOT = os.path.dirname(os.path.abspath(__file__))
os.chdir(ROOT)

def check(pkg):
    try:
        __import__(pkg.replace("-","_"))
        return True
    except ImportError:
        return False

REQUIRED = ["flask", "flask_cors", "numpy", "joblib", "sklearn", "xgboost"]
OPTIONAL = ["pymongo", "tensorflow", "PIL"]

print("=" * 55)
print("  🌱  AgroRover Intelligence Dashboard")
print("=" * 55)

# Required deps
missing = [p for p in REQUIRED if not check(p)]
if missing:
    print(f"\n⚠  Missing required packages: {', '.join(missing)}")
    ans = input("Install now? [Y/n]: ").strip().lower()
    if ans != 'n':
        subprocess.check_call([sys.executable, "-m", "pip", "install",
                               "flask", "flask-cors", "flask-pymongo",
                               "pymongo", "scikit-learn", "xgboost",
                               "numpy", "joblib", "--break-system-packages", "-q"])
    else:
        print("Aborting. Install with: pip install -r requirements.txt")
        sys.exit(1)

# Optional deps
for pkg in OPTIONAL:
    if not check(pkg):
        print(f"  ℹ  Optional: {pkg} not found (some features disabled)")

# MongoDB
try:
    from pymongo import MongoClient
    MongoClient("mongodb://localhost:27017/", serverSelectionTimeoutMS=1000).server_info()
    print("\n  ✅ MongoDB: connected")
except Exception:
    print("\n  ℹ  MongoDB: not running (using in-memory store — data resets on restart)")
    print("     To enable persistence: install & start MongoDB, then re-run.")

# Model check
models_dir = os.path.join(ROOT, "models")
models = {
    "rf_anomaly_model.joblib": "Component 1 – Anomaly Detection",
    "kmeans_field_zone.pkl":   "Component 3 – Zone Mapping",
    "xgb_soil_health.pkl":     "Component 4 – XGBoost Soil Health",
    "lstm_soil_health.h5":     "Component 4 – LSTM Soil Health",
}
print("\n  Model Status:")
for fname, label in models.items():
    path = os.path.join(models_dir, fname)
    status = "✅" if os.path.exists(path) else "❌ MISSING"
    print(f"    {status}  {label}")

c2_path = os.path.join(models_dir, "chilli_disease_model.keras")
c2_h5   = os.path.join(models_dir, "chilli_disease_model.h5")
if os.path.exists(c2_path) or os.path.exists(c2_h5):
    print(f"    ✅  Component 2 – Chilli Disease Detection")
else:
    print(f"    ⏳  Component 2 – Model not yet available (simulation mode)")

print("\n  ⚠  Note: TensorFlow takes ~20-25s to initialise on first start.")
print("     The dashboard will be available at http://localhost:5000")
print("=" * 55)

# Launch Flask
print("\n🚀 Starting AgroRover Dashboard…\n")
time.sleep(0.5)

# Open browser after short delay
def open_browser():
    time.sleep(25)
    webbrowser.open("http://localhost:5000")

import threading
threading.Thread(target=open_browser, daemon=True).start()

from app import app
app.run(host="0.0.0.0", port=5000, debug=False, threaded=True, use_reloader=False)
