#!/bin/bash
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "============================================"
echo "  🌱  AgroRover Intelligence Dashboard"
echo "============================================"
echo ""

# Check python
if ! command -v python3 &>/dev/null; then
    echo "ERROR: python3 not found. Install Python 3.9+"
    exit 1
fi

echo "Python: $(python3 --version)"
echo ""
echo "Installing/checking dependencies..."
python3 -m pip install flask flask-cors flask-pymongo pymongo scikit-learn xgboost numpy joblib --break-system-packages -q 2>/dev/null || \
python3 -m pip install flask flask-cors flask-pymongo pymongo scikit-learn xgboost numpy joblib -q

echo ""
echo "Starting dashboard on http://localhost:5000"
echo "(TensorFlow may take 20-25 seconds to initialise)"
echo ""
echo "Press Ctrl+C to stop."
echo ""

python3 start.py
