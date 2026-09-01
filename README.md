# 🌱 AgroRover Intelligence Dashboard

A Flask + MongoDB rover management dashboard powered by four ML components for agricultural intelligence.

## Architecture

```
agro_rover/
├── app.py                    # Flask backend — APIs + ML inference
├── models/                   # All trained model files
│   ├── rf_anomaly_model.joblib      (Component 1 – Anomaly)
│   ├── feature_scaler.joblib
│   ├── model_features.joblib
│   ├── kmeans_field_zone.pkl        (Component 3 – Zone Mapping)
│   ├── scaler_field_zone.pkl
│   ├── model_metadata.json
│   ├── xgb_soil_health.pkl          (Component 4 – Soil Health)
│   ├── lstm_soil_health.h5
│   ├── scaler.pkl
│   ├── label_encoder_*.pkl
│   └── metadata.json
├── templates/
│   └── dashboard.html               # Single-page dashboard UI
├── static/
│   ├── css/dashboard.css
│   ├── js/dashboard.js
│   └── outputs/                     # Model evaluation outputs (PNG)
│       ├── component1/
│       ├── component3/
│       └── component4/
└── requirements.txt
```

## ML Components

| Component | Student ID     | Task                    | Model               |
|-----------|---------------|-------------------------|---------------------|
| 1         | IT22112682    | Soil Moisture Anomaly   | Random Forest       |
| 2         | IT22108722    | Chilli Disease Detection| EfficientNetB0 (Keras) — add when ready |
| 3         | IT22276032    | Field Zone Mapping      | KMeans Clustering   |
| 4         | IT22192950    | Soil Health Detection   | LSTM + XGBoost      |

## Quick Start

### 1. Install dependencies
```bash
pip install -r requirements.txt
```

### 2. (Optional) Start MongoDB
```bash
mongod --dbpath /data/db
```
> Without MongoDB, the app runs with in-memory storage (data resets on restart).

### 3. Run
```bash
python app.py
```

### 4. Open browser
```
http://localhost:5000
```

## Features

### Control Center (Main Panel)
- **Live SOL/Time** bar with battery, AI status, anomaly, soil, and zone badges
- **Rover Status** — cell, gas pressure, mode, speed, GPS
- **Soil Moisture Depth** bars (VW 30–150cm, animated)
- **Soil Temperature** depth bars
- **Field Terrain Map** — animated canvas with rover path tracking
- **Live Sensor Readings** — NPK / Spectral / Environmental tabs
- **AI Inference panel** — animated radar, anomaly score, zone, soil health
- **Camera Control** — webcam or DroidCam/IP camera

### Simulation
- Click **▶ START SIM** to begin live sensor simulation with random walk
- Inference runs every second using actual loaded ML models
- Click **⚙ MANUAL INPUT** to inject custom sensor values and trigger immediate inference

### DroidCam Phone Camera
1. Install DroidCam on your phone
2. Connect phone and PC to same WiFi
3. Go to **CAMERA** tab → select **DroidCam via WiFi**
4. Enter your phone IP (e.g. `192.168.1.100:4747`)
5. Click **CONNECT CAMERA**

### Analytics Panel
Real-time charts of:
- Soil moisture trend
- Temperature trend
- NDVI trend
- NPK values (N, P, K overlay)

### Diagnostics Panel
Browse all model evaluation output images from all components. Click any image to zoom.

### AI Inference Panels
- **SOIL AI** — Direct Component 4 inference (XGBoost + LSTM consensus)
- **ANOMALY** — Direct Component 1 inference (Random Forest)
- **ZONE MAP** — Direct Component 3 inference (KMeans clustering)
- Each panel has **Fill from Simulation** button to auto-populate from live data

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/status` | Full rover + sensor + inference status |
| POST | `/api/simulation/toggle` | Start/pause simulation |
| POST | `/api/simulation/manual` | Inject manual sensor values |
| POST | `/api/anomaly/predict` | Run anomaly detection |
| GET | `/api/anomaly/history` | Anomaly detection history |
| POST | `/api/soil/predict` | Run soil health prediction |
| POST | `/api/zone/predict` | Run zone mapping |
| GET | `/api/sensors/history` | Sensor reading history |
| GET | `/api/logs` | Mission log entries |
| POST | `/api/logs/add` | Add mission log entry |
| GET | `/api/outputs/<component>` | List output images for component |

## Adding Component 2 (Chilli Disease Detection)
When the Keras model is ready:
1. Copy model file to `models/chilli_disease_model.keras`
2. In `app.py`, add load + route for `/api/disease/predict`
3. Add an image upload form in the dashboard

## MongoDB Collections
- `sensor_history` — time-series sensor readings
- `anomaly_history` — anomaly detection results
- `mission_logs` — mission events and logs
- `camera_events` — camera captures (optional)
