"""
AgroRover Intelligence Dashboard
Flask + MongoDB backend for multi-component ML rover management system
"""

from flask import Flask, render_template, jsonify, request, Response, send_from_directory
from flask_cors import CORS
import json, os, random, math, time, datetime, threading, warnings
import numpy as np
import joblib

warnings.filterwarnings("ignore")

app = Flask(__name__)
CORS(app)
app.config['UPLOAD_FOLDER'] = 'uploads'


BASE_DIR = os.path.dirname(os.path.abspath(__file__))

def load_json(filename):
    path = os.path.join(BASE_DIR, filename)
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)

CONFIG = load_json("simulation_config.json")
KB     = load_json("knowledge_base.json")

SENSOR_RANGES  = CONFIG["sensor_ranges"]
ROVER_CFG      = CONFIG["rover"]
SIM_CFG        = CONFIG["simulation"]
MISSION_CFG    = CONFIG["mission"]
API_DEFAULTS   = CONFIG["api_defaults"]
HISTORY_LIMIT  = SIM_CFG["history_limit"]

print(" Configuration loaded from simulation_config.json + knowledge_base.json")

# ─── MongoDB (optional – gracefully fallback to in-memory) ───────────────────
try:
    from pymongo import MongoClient
    client = MongoClient("mongodb://localhost:27017/", serverSelectionTimeoutMS=2000)
    client.server_info()
    db = client["agro_rover"]
    USE_MONGO = True
    print(" MongoDB connected")
except Exception:
    USE_MONGO = False
    print("⚠️  MongoDB not available – using in-memory store")

# In-memory store as fallback
in_memory_store = {
    "sensor_history": [],
    "anomaly_history": [],
    "mission_logs": [],
    "camera_events": []
}

def db_insert(collection, doc):
    """Store a document. A COPY is always inserted — pymongo's insert_one mutates
    the dict it is given by adding an ObjectId under '_id', which then breaks
    jsonify() if the caller reuses that same dict in its response."""
    record = dict(doc)
    record["timestamp"] = datetime.datetime.utcnow().isoformat()
    if USE_MONGO:
        db[collection].insert_one(record)
    else:
        in_memory_store.setdefault(collection, []).append(record)
        in_memory_store[collection] = in_memory_store[collection][-HISTORY_LIMIT:]

def db_find(collection, limit=50):
    if USE_MONGO:
        docs = list(db[collection].find({}, {"_id": 0}).sort("timestamp", -1).limit(limit))
    else:
        docs = list(reversed(in_memory_store.get(collection, [])))[:limit]
    return docs

# ─── Load ML Models ──────────────────────────────────────────────────────────
MODELS_DIR = os.path.join(os.path.dirname(__file__), "models")

def safe_load(path):
    try:
        return joblib.load(path)
    except Exception as e:
        print(f"⚠️  Could not load {path}: {e}")
        return None

# Component 1 – Anomaly Detection
c1_scaler   = safe_load(os.path.join(MODELS_DIR, "feature_scaler.joblib"))
c1_rf       = safe_load(os.path.join(MODELS_DIR, "rf_anomaly_model.joblib"))
c1_features = safe_load(os.path.join(MODELS_DIR, "model_features.joblib"))

# Component 3 – Field Zone Mapping
c3_scaler = safe_load(os.path.join(MODELS_DIR, "scaler_field_zone.pkl"))
c3_kmeans = safe_load(os.path.join(MODELS_DIR, "kmeans_field_zone.pkl"))
with open(os.path.join(MODELS_DIR, "model_metadata.json")) as f:
    c3_meta = json.load(f)

# Component 4 – Soil Health
c4_scaler     = safe_load(os.path.join(MODELS_DIR, "scaler.pkl"))
c4_le_crop    = safe_load(os.path.join(MODELS_DIR, "label_encoder_crop.pkl"))
c4_le_health  = safe_load(os.path.join(MODELS_DIR, "label_encoder_health.pkl"))
c4_le_soil    = safe_load(os.path.join(MODELS_DIR, "label_encoder_soiltype.pkl"))
c4_xgb        = safe_load(os.path.join(MODELS_DIR, "xgb_soil_health.pkl"))
with open(os.path.join(MODELS_DIR, "metadata.json")) as f:
    c4_meta = json.load(f)

try:
    import tensorflow as tf
    tf.get_logger().setLevel('ERROR')
    c4_lstm = tf.keras.models.load_model(os.path.join(MODELS_DIR, "lstm_soil_health.h5"))
    # Warm-up call to build the model so .inputs works
    _dummy = np.zeros((1, 1, 7))
    c4_lstm.predict(_dummy, verbose=0)
    # Build embedding extractor (layer 5 = "embedding" Dense, 64-dim output)
    c4_embed_model = tf.keras.Model(inputs=c4_lstm.inputs, outputs=c4_lstm.layers[5].output)
    print("✅ LSTM loaded + embedding model ready")
except Exception as e:
    c4_lstm = None
    c4_embed_model = None
    print(f"⚠️  LSTM not loaded: {e}")

# ─── Simulation State ─────────────────────────────────────────────────────────
_sim_state = {
    "running": False,
    "speed": ROVER_CFG["speed"],
    "battery": ROVER_CFG["battery"],
    "gps_lat": ROVER_CFG["gps_lat"],
    "gps_lon": ROVER_CFG["gps_lon"],
    "heading": ROVER_CFG["heading"],
    "distance_travelled": ROVER_CFG["distance_travelled"],
    "remaining_distance": ROVER_CFG["remaining_distance"],
    "mission_day": MISSION_CFG["mission_day"],
    "sol": MISSION_CFG["sol"],
    "last_update": time.time(),
    "sensors": dict(CONFIG["initial_sensors"]),
    **CONFIG["initial_inference"]
}
_lock     = threading.Lock()
_tf_lock  = threading.Lock()   # Serialises TF calls across threads
_tick_count = 0


def _random_walk(val, lo, hi, step):
    val += random.uniform(-step, step)
    return max(lo, min(hi, val))


def _walk_sensor(sensors, key):
    """Random-walk one sensor using the bounds defined in simulation_config.json"""
    r = SENSOR_RANGES.get(key)
    if not r:
        return
    sensors[key] = _random_walk(sensors[key], r["min"], r["max"], r["step"])


def _simulate_tick():
    """Background simulation tick — every constant comes from simulation_config.json"""
    global _tick_count
    with _lock:
        s = _sim_state
        if not s["running"]:
            return
        sensors = s["sensors"]

        # Walk every sensor that has a range defined in the config file
        for key in sensors:
            _walk_sensor(sensors, key)

        # Rover state
        drain_lo, drain_hi = ROVER_CFG["battery_drain_per_tick"]
        s["battery"] = max(ROVER_CFG["battery_min"],
                           s["battery"] - random.uniform(drain_lo, drain_hi))
        s["speed"]   = _random_walk(s["speed"], ROVER_CFG["speed_min"],
                                    ROVER_CFG["speed_max"], ROVER_CFG["speed_step"])
        jitter = ROVER_CFG["gps_jitter"]
        s["gps_lat"] += random.uniform(-jitter, jitter)
        s["gps_lon"] += random.uniform(-jitter, jitter)
        hj = ROVER_CFG["heading_jitter"]
        s["heading"] = (s["heading"] + random.uniform(-hj, hj)) % 360
        step_km = s["speed"] * ROVER_CFG["distance_per_speed_unit_per_tick"]
        s["distance_travelled"] += step_km
        s["remaining_distance"] = max(0.0, s["remaining_distance"] - step_km)
        s["last_update"] = time.time()

        # Run inference every tick
        _run_inference_tick(s)

        # Persist at the interval defined in the config file
        _tick_count += 1
        if _tick_count % SIM_CFG["persist_every_n_ticks"] == 0:
            db_insert("sensor_history", {**sensors, "battery": s["battery"], "speed": s["speed"]})


def _run_inference_tick(s):
    sensors = s["sensors"]
    # ── C1 Anomaly ──
    if c1_rf and c1_scaler and c1_features:
        try:
            vw = [sensors["vw_30cm"],sensors["vw_60cm"],sensors["vw_90cm"],sensors["vw_120cm"],sensors["vw_150cm"]]
            t  = [sensors["t_30cm"],sensors["t_60cm"],sensors["t_90cm"],sensors["t_120cm"],sensors["t_150cm"]]
            roll_mean = [sum(vw)/5]*5 + [sum(t)/5]*5
            roll_std  = [np.std(vw)]*5 + [np.std(t)]*5
            grad = vw[0] - vw[-1]
            delta = vw[0] - sensors["vw_60cm"]
            doy = datetime.datetime.now().timetuple().tm_yday
            month = datetime.datetime.now().month
            feat = vw + t + roll_mean + roll_std + [grad, delta, doy, month]
            arr = np.array([feat])
            arr_s = c1_scaler.transform(arr)
            pred = c1_rf.predict(arr_s)[0]
            prob = c1_rf.predict_proba(arr_s)[0]
            s["anomaly_status"] = "ANOMALY" if pred == 1 else "Normal"
            s["anomaly_score"] = float(max(prob))
        except Exception as e:
            pass

    # ── C3 Zone ──
    if c3_kmeans and c3_scaler:
        try:
            feat3 = np.array([[sensors["nir"], sensors["swir"], sensors["ndvi"],
                               sensors["ndwi"], sensors["evi"],  sensors["savi"]]])
            feat3_s = c3_scaler.transform(feat3)
            zone = int(c3_kmeans.predict(feat3_s)[0])
            s["zone_id"] = zone
            s["zone_label"] = c3_meta["zone_labels"].get(str(zone), f"Zone {zone}")
        except Exception:
            pass

    # ── C4 Soil Health ──
    if c4_scaler and c4_lstm:
        try:
            feat4 = np.array([[sensors["nitrogen"], sensors["phosphorus"], sensors["potassium"],
                               sensors["temperature"], sensors["humidity"],
                               sensors["ph_value"], sensors["rainfall"]]])
            feat4_s = c4_scaler.transform(feat4)
            feat4_l = feat4_s.reshape(1, 1, feat4_s.shape[1])
            # Run TF inside the tf_lock to avoid thread conflicts
            with _tf_lock:
                lstm_out = c4_lstm.predict(feat4_l, verbose=0)
                lstm_pred = int(np.argmax(lstm_out[0]))
                if c4_xgb and c4_embed_model:
                    embedding = c4_embed_model.predict(feat4_l, verbose=0)
            if c4_xgb and c4_embed_model:
                xgb_input = np.hstack([embedding, feat4_s])
                pred4 = c4_xgb.predict(xgb_input)[0]
                prob4 = c4_xgb.predict_proba(xgb_input)[0]
                s["soil_health"] = c4_le_health.inverse_transform([pred4])[0]
                s["soil_confidence"] = float(max(prob4))
            else:
                s["soil_health"] = c4_le_health.inverse_transform([lstm_pred])[0]
                s["soil_confidence"] = float(max(lstm_out[0]))
        except Exception:
            pass


# Background simulation thread — resilient to per-tick errors
def _sim_loop():
    while True:
        try:
            _simulate_tick()
        except Exception:
            pass
        time.sleep(SIM_CFG["tick_seconds"])

_bg = threading.Thread(target=_sim_loop, daemon=True)
_bg.start()


# ─── Routes ──────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    return render_template("dashboard.html")


@app.route("/api/config")
def api_config():
    """Serves simulation_config.json so the frontend holds no hardcoded values either."""
    return jsonify({
        "mission": MISSION_CFG,
        "rover": ROVER_CFG,
        "initial_sensors": CONFIG["initial_sensors"],
        "sensor_ranges": SENSOR_RANGES,
        "disease_classes": _C2_CLASSES,
        "nutrient_thresholds": KB["fertilizer"]["nutrient_thresholds"]
    })


@app.route("/api/status")
def api_status():
    with _lock:
        s = dict(_sim_state)
    return jsonify({
        "mission": {
            "sol": s["sol"],
            "mission_day": s["mission_day"],
            "time": datetime.datetime.now().strftime("%H:%M:%S"),
            "sunrise": MISSION_CFG["sunrise"],
            "sunset": MISSION_CFG["sunset"]
        },
        "rover": {
            "battery": round(s["battery"], 1),
            "speed": round(s["speed"], 1),
            "heading": round(s["heading"], 1),
            "gps_lat": round(s["gps_lat"], 6),
            "gps_lon": round(s["gps_lon"], 6),
            "distance_travelled": round(s["distance_travelled"], 1),
            "remaining_distance": round(s["remaining_distance"], 1),
            "mode": "DRV" if s["running"] else "IDLE",
            "cell": random.randint(*ROVER_CFG["cell_range"]),
            "gas_press": round(random.uniform(*ROVER_CFG["gas_press_range"]), 2)
        },
        "simulation": {"running": s["running"]},
        "sensors": {k: round(v, 4) if isinstance(v, float) else v
                    for k, v in s["sensors"].items()},
        "inference": {
            "anomaly_status": s["anomaly_status"],
            "anomaly_score": round(s["anomaly_score"], 4),
            "zone_label": s["zone_label"],
            "zone_id": s["zone_id"],
            "soil_health": s["soil_health"],
            "soil_confidence": round(s["soil_confidence"], 4)
        }
    })


@app.route("/api/simulation/toggle", methods=["POST"])
def toggle_simulation():
    with _lock:
        _sim_state["running"] = not _sim_state["running"]
        state = _sim_state["running"]
    db_insert("mission_logs", {"event": "simulation_toggled", "running": state})
    return jsonify({"running": state, "message": "Simulation " + ("started" if state else "paused")})


@app.route("/api/simulation/manual", methods=["POST"])
def manual_sensor():
    """Manually set sensor values"""
    data = request.json or {}
    with _lock:
        for k, v in data.items():
            if k in _sim_state["sensors"]:
                _sim_state["sensors"][k] = float(v)
        _run_inference_tick(_sim_state)
        result = {
            "sensors": dict(_sim_state["sensors"]),
            "anomaly_status": _sim_state["anomaly_status"],
            "anomaly_score": _sim_state["anomaly_score"],
            "zone_label": _sim_state["zone_label"],
            "soil_health": _sim_state["soil_health"],
            "soil_confidence": _sim_state["soil_confidence"]
        }
    db_insert("sensor_history", data)
    return jsonify(result)


# ── Component 1 – Anomaly Detection ──────────────────────────────────────────
@app.route("/api/anomaly/predict", methods=["POST"])
def predict_anomaly():
    data = request.json or {}
    try:
        sensors = data.get("sensors", {})
        vw_def = API_DEFAULTS["anomaly"]["vw_default"]
        t_def  = API_DEFAULTS["anomaly"]["t_default"]
        vw = [sensors.get(f"vw_{d}cm", vw_def) for d in [30,60,90,120,150]]
        t  = [sensors.get(f"t_{d}cm",  t_def)  for d in [30,60,90,120,150]]
        roll_mean = [sum(vw)/5]*5 + [sum(t)/5]*5
        roll_std  = [np.std(vw)]*5 + [np.std(t)]*5
        grad  = vw[0] - vw[-1]
        delta = vw[0] - vw[1]
        doy   = datetime.datetime.now().timetuple().tm_yday
        month = datetime.datetime.now().month
        feat  = vw + t + roll_mean + roll_std + [grad, delta, doy, month]
        arr   = np.array([feat])
        arr_s = c1_scaler.transform(arr)
        pred  = int(c1_rf.predict(arr_s)[0])
        prob  = c1_rf.predict_proba(arr_s)[0].tolist()
        result = {
            "prediction": "ANOMALY" if pred == 1 else "Normal",
            "label": pred,
            "probabilities": {"normal": round(prob[0],4), "anomaly": round(prob[1],4)},
            "confidence": round(max(prob), 4)
        }
        db_insert("anomaly_history", result)
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/anomaly/history")
def anomaly_history():
    return jsonify(db_find("anomaly_history", 100))


# ── Component 3 – Zone Mapping ────────────────────────────────────────────────
@app.route("/api/zone/predict", methods=["POST"])
def predict_zone():
    data = request.json or {}
    try:
        zd = API_DEFAULTS["zone"]
        feat = np.array([[
            data.get("nir",  zd["nir"]),  data.get("swir", zd["swir"]),
            data.get("ndvi", zd["ndvi"]), data.get("ndwi", zd["ndwi"]),
            data.get("evi",  zd["evi"]),  data.get("savi", zd["savi"])
        ]])
        feat_s = c3_scaler.transform(feat)
        zone   = int(c3_kmeans.predict(feat_s)[0])
        label  = c3_meta["zone_labels"].get(str(zone), f"Zone {zone}")
        dist   = [round(float(d),4) for d in c3_kmeans.transform(feat_s)[0]]
        return jsonify({"zone_id": zone, "zone_label": label,
                        "distances_to_centers": dist, "n_zones": c3_kmeans.n_clusters})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ── Fertilizer recommendation (knowledge_base.json) ──────────────────────────
def _nutrient_level(value, thresholds):
    if value < thresholds["low"]:
        return "Low"
    if value > thresholds["high"]:
        return "High"
    return "Optimal"


def build_fertilizer_recommendation(raw, health_class):
    """Map raw soil values + predicted health class to a fertilizer plan."""
    fert = KB["fertilizer"]
    thresholds = fert["nutrient_thresholds"]

    nutrients = []
    for name in ["nitrogen", "phosphorus", "potassium"]:
        level  = _nutrient_level(raw[name], thresholds[name])
        action = fert["nutrient_actions"][name][level]
        nutrients.append({
            "nutrient": name.capitalize(),
            "value": round(raw[name], 1),
            "unit": thresholds[name]["unit"],
            "level": level,
            "status_class": action["status_class"],
            "product": action["product"],
            "dose": action["dose"],
            "note": action["note"]
        })

    # pH band
    ph = raw["ph_value"]
    ph_band = fert["ph_bands"][-1]
    for band in fert["ph_bands"]:
        if ph <= band["max"]:
            ph_band = band
            break

    plan = fert["health_plan"].get(health_class, fert["health_plan"]["Moderate"])
    deficient = [n["nutrient"] for n in nutrients if n["level"] == "Low"]
    excess    = [n["nutrient"] for n in nutrients if n["level"] == "High"]

    if deficient:
        priority = "Correct the " + ", ".join(deficient) + " deficiency first"
    elif excess:
        priority = "Reduce " + ", ".join(excess) + " — hold back on those fertilizers"
    else:
        priority = "All three major nutrients are in range — apply the maintenance dose only"

    return {
        "headline": plan["headline"],
        "status_class": plan["status_class"],
        "strategy": plan["strategy"],
        "priority": priority,
        "nutrients": nutrients,
        "ph": {
            "value": round(ph, 2),
            "label": ph_band["label"],
            "status_class": ph_band["status_class"],
            "advice": ph_band["advice"]
        },
        "organic_matter": plan["organic_matter"],
        "application_schedule": plan["application_schedule"],
        "retest_after_days": plan["retest_after_days"]
    }


# ── Component 4 – Soil Health ─────────────────────────────────────────────────
@app.route("/api/soil/predict", methods=["POST"])
def predict_soil():
    data = request.json or {}
    try:
        sd = API_DEFAULTS["soil"]
        raw = {k: float(data.get(k, sd[k])) for k in
               ["nitrogen", "phosphorus", "potassium", "temperature",
                "humidity", "ph_value", "rainfall"]}
        feat = np.array([[raw["nitrogen"], raw["phosphorus"], raw["potassium"],
                          raw["temperature"], raw["humidity"],
                          raw["ph_value"], raw["rainfall"]]])
        feat_s = c4_scaler.transform(feat)

        # LSTM prediction
        lstm_label = "Unknown"
        lstm_prob  = [0.33, 0.33, 0.34]
        if c4_lstm:
            feat_lstm = feat_s.reshape(1, 1, feat_s.shape[1])
            lstm_out  = c4_lstm.predict(feat_lstm, verbose=0)
            lstm_pred = int(np.argmax(lstm_out[0]))
            lstm_prob = lstm_out[0].tolist()
            lstm_label = c4_le_health.inverse_transform([lstm_pred])[0]

        # XGBoost needs LSTM embeddings (64) + raw features (7) = 71
        xgb_label = lstm_label
        xgb_prob  = lstm_prob
        if c4_xgb and c4_embed_model:
            try:
                feat_lstm_in = feat_s.reshape(1, 1, feat_s.shape[1])
                embedding = c4_embed_model.predict(feat_lstm_in, verbose=0)
                xgb_input = np.hstack([embedding, feat_s])
                xgb_pred  = int(c4_xgb.predict(xgb_input)[0])
                xgb_prob  = c4_xgb.predict_proba(xgb_input)[0].tolist()
                xgb_label = c4_le_health.inverse_transform([xgb_pred])[0]
            except Exception:
                pass

        return jsonify({
            "xgboost": {"health": xgb_label, "probabilities": {
                c4_meta["class_names"][i]: round(xgb_prob[i], 4)
                for i in range(len(xgb_prob))}},
            "lstm": {"health": lstm_label, "probabilities": {
                c4_meta["class_names"][i]: round(lstm_prob[i], 4)
                for i in range(len(lstm_prob))}},
            "consensus": xgb_label,
            "feature_names": c4_meta["feature_cols"],
            "fertilizer": build_fertilizer_recommendation(raw, xgb_label)
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ── Sensor history ────────────────────────────────────────────────────────────
@app.route("/api/sensors/history")
def sensor_history():
    return jsonify(db_find("sensor_history", 60))


# ── Mission logs ──────────────────────────────────────────────────────────────
@app.route("/api/logs")
def mission_logs():
    logs = db_find("mission_logs", 50)
    if not logs:
        logs = [{"event": "system_boot", "timestamp": datetime.datetime.utcnow().isoformat(),
                 "message": "AgroRover Intelligence System initialized"}]
    return jsonify(logs)


@app.route("/api/logs/add", methods=["POST"])
def add_log():
    data = request.json or {}
    db_insert("mission_logs", data)
    return jsonify({"ok": True})


# ── Output images ─────────────────────────────────────────────────────────────
@app.route("/api/outputs/<component>")
def list_outputs(component):
    folder = os.path.join("static", "outputs", component)
    if not os.path.exists(folder):
        return jsonify([])
    files = [f for f in os.listdir(folder) if f.endswith(".png")]
    return jsonify(files)


@app.route("/static/outputs/<component>/<filename>")
def serve_output(component, filename):
    return send_from_directory(os.path.join("static", "outputs", component), filename)


# ── Camera stream ─────────────────────────────────────────────────────────────
# ── Component 2 – Chilli Disease Detection ───────────────────────────────────
# Model loads dynamically when placed at models/chilli_disease_model.keras
_c2_model = None
_C2_CLASSES = CONFIG["disease_classes"]


def build_disease_advice(disease_name, confidence):
    """Map a predicted disease class to its treatment plan and growth outlook."""
    treatment = KB["disease_treatment"].get(disease_name)
    growth    = KB["growth_monitoring"].get(disease_name)

    if treatment is None or growth is None:
        return None, None

    treatment = dict(treatment)
    growth    = dict(growth)

    # Confidence tempers how firmly the advice is stated
    if confidence < 0.60:
        treatment["confidence_note"] = (
            "Confidence is low. Confirm visually or retake the photo in better light "
            "before applying any chemical treatment."
        )
    elif confidence < 0.80:
        treatment["confidence_note"] = (
            "Moderate confidence. Start with the organic or cultural measures and "
            "re-check the plant in a few days."
        )
    else:
        treatment["confidence_note"] = "High confidence — proceed with the plan below."

    growth["next_check_date"] = (
        datetime.date.today() +
        datetime.timedelta(days=growth["monitoring_interval_days"])
    ).isoformat()

    return treatment, growth

def _get_c2_model():
    global _c2_model
    if _c2_model is not None:
        return _c2_model
    model_path = os.path.join(MODELS_DIR, "chilli_disease_model.keras")
    if not os.path.exists(model_path):
        model_path = os.path.join(MODELS_DIR, "chilli_disease_model.h5")
    if os.path.exists(model_path):
        try:
            _c2_model = tf.keras.models.load_model(model_path)
            print("✅ Component 2 (Chilli Disease) model loaded")
        except Exception as e:
            print(f"⚠️  Component 2 model load failed: {e}")
    return _c2_model


@app.route("/api/disease/predict", methods=["POST"])
def predict_disease():
    """Component 2 – Chilli disease detection from uploaded image"""
    import base64
    from io import BytesIO

    # Accept either multipart file or JSON base64
    img_data = None
    if request.files.get("image"):
        img_data = request.files["image"].read()
    elif request.json and request.json.get("image_b64"):
        img_data = base64.b64decode(request.json["image_b64"])

    if img_data is None:
        return jsonify({"error": "No image provided"}), 400

    model = _get_c2_model()
    if model is None:
        # Return a simulated result so UI still works before model is ready
        sim_cfg = CONFIG["disease_simulation"]
        cls = random.choice(_C2_CLASSES)
        probs = [random.uniform(*sim_cfg["other_confidence_range"]) for _ in _C2_CLASSES]
        idx = _C2_CLASSES.index(cls)
        probs[idx] = random.uniform(*sim_cfg["top_confidence_range"])
        total = sum(probs); probs = [p/total for p in probs]
        conf = round(probs[idx], 4)
        treatment, growth = build_disease_advice(cls, conf)
        return jsonify({
            "prediction": cls,
            "confidence": conf,
            "probabilities": {c: round(p, 4) for c, p in zip(_C2_CLASSES, probs)},
            "model_status": "simulated",
            "treatment": treatment,
            "growth_monitoring": growth
        })

    try:
        from PIL import Image
        img = Image.open(BytesIO(img_data)).convert("RGB").resize((224, 224))
        arr = np.array(img, dtype=np.float32)  # EfficientNet expects raw [0-255]
        arr = np.expand_dims(arr, 0)
        preds = model.predict(arr, verbose=0)[0]
        pred_idx = int(np.argmax(preds))
        # Map to class names (use model output length if different)
        classes = _C2_CLASSES[:len(preds)] if len(preds) <= len(_C2_CLASSES) else \
                  [f"Class_{i}" for i in range(len(preds))]
        confidence = round(float(preds[pred_idx]), 4)
        prediction = classes[pred_idx]
        treatment, growth = build_disease_advice(prediction, confidence)
        result = {
            "prediction": prediction,
            "confidence": confidence,
            "probabilities": {c: round(float(p), 4) for c, p in zip(classes, preds)},
            "model_status": "live"
        }
        db_insert("camera_events", {"type": "disease_detection", **result})
        result["treatment"] = treatment
        result["growth_monitoring"] = growth
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/disease/status")
def disease_model_status():
    model_path_keras = os.path.join(MODELS_DIR, "chilli_disease_model.keras")
    model_path_h5    = os.path.join(MODELS_DIR, "chilli_disease_model.h5")
    ready = os.path.exists(model_path_keras) or os.path.exists(model_path_h5)
    return jsonify({
        "ready": ready,
        "message": "Model ready" if ready else "Place chilli_disease_model.keras in models/ folder",
        "classes": _C2_CLASSES
    })


# ── Camera stream ─────────────────────────────────────────────────────────────
@app.route("/api/camera/stream")
def camera_stream():
    cam_url  = request.args.get("url", "")
    cam_type = request.args.get("type", "webcam")
    return jsonify({"type": cam_type, "url": cam_url,
                    "message": "Connect DroidCam client to get phone camera feed"})


# ── Mobile Rover Controller ───────────────────────────────────────────────────
# Rover connection + command state
_rover_state = {
    "connected": False,
    "last_command": None,
    "last_command_time": None,
}

@app.route("/controller")
def controller():
    """Mobile-only rover controller page"""
    return render_template("controller.html")

@app.route("/api/rover/connection", methods=["POST"])
def rover_connection():
    """Toggle rover connection state"""
    data = request.json or {}
    _rover_state["connected"] = data.get("connected", False)
    status = "connected" if _rover_state["connected"] else "disconnected"
    db_insert("mission_logs", {
        "event": "rover_" + status,
        "message": "Rover " + status + " via mobile controller"
    })
    return jsonify({"connected": _rover_state["connected"], "status": status})

@app.route("/api/rover/connection", methods=["GET"])
def rover_connection_status():
    return jsonify({"connected": _rover_state["connected"]})

@app.route("/api/rover/command", methods=["POST"])
def rover_command():
    """Receive a movement command from the mobile controller"""
    data = request.json or {}
    command = data.get("command", "")   # W / A / S / D / STOP
    if not _rover_state["connected"]:
        return jsonify({"ok": False, "error": "Rover not connected"}), 400

    _rover_state["last_command"] = command
    _rover_state["last_command_time"] = datetime.datetime.utcnow().isoformat()

    # Map command to a sim state change
    with _lock:
        step_v = ROVER_CFG["speed_command_step"]
        step_h = ROVER_CFG["heading_command_step"]
        if command == "W":
            _sim_state["speed"] = min(ROVER_CFG["speed_max"], _sim_state["speed"] + step_v)
        elif command == "S":
            _sim_state["speed"] = max(ROVER_CFG["speed_min"], _sim_state["speed"] - step_v)
        elif command == "A":
            _sim_state["heading"] = (_sim_state["heading"] - step_h) % 360
        elif command == "D":
            _sim_state["heading"] = (_sim_state["heading"] + step_h) % 360
        elif command == "STOP":
            _sim_state["speed"] = 0

    db_insert("mission_logs", {
        "event": "rover_command",
        "message": "Command received: " + command
    })
    return jsonify({"ok": True, "command": command,
                    "speed": _sim_state["speed"],
                    "heading": _sim_state["heading"]})


if __name__ == "__main__":
    print("🚀 AgroRover Dashboard starting on http://localhost:5000")
    app.run(debug=False, host="0.0.0.0", port=5000, threaded=True, use_reloader=False)
