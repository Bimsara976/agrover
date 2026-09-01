@echo off
echo ============================================
echo   AgroRover Intelligence Dashboard
echo ============================================
echo.

cd /d "%~dp0"

where python >nul 2>&1
if errorlevel 1 (
    echo ERROR: Python not found. Install Python 3.9+ from https://python.org
    pause
    exit /b 1
)

python --version
echo.
echo Installing/checking dependencies...
python -m pip install flask flask-cors flask-pymongo pymongo scikit-learn xgboost numpy joblib --quiet

echo.
echo Starting dashboard on http://localhost:5000
echo (TensorFlow may take 20-25 seconds to load)
echo.
echo Press Ctrl+C to stop.
echo.

python start.py
pause
