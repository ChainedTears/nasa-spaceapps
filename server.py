"""
Web UI for the fire scripts.

    python3 server.py        then open http://localhost:8765

Serves the page in web/ and JSON endpoints backed by firedata.py:
records for an area and period, live fires worldwide, and a fire calendar.
"""

import functools
import gzip
import math
import traceback

from flask import Flask, jsonify, request, send_from_directory

import firedata

app = Flask(__name__, static_folder="web", static_url_path="")


@functools.lru_cache(maxsize=64)
def cached(kind, bbox, start, end, extra):
    if kind == "fires":
        return firedata.modis_fires(list(bbox), start, end)
    if kind == "baseline":
        return firedata.modis_baseline(list(bbox), start, end, years=extra)
    if kind == "radiative":
        return firedata.radiative_power(list(bbox), start, end)
    if kind == "severity":
        first, last = extra
        return firedata.burn_severity(list(bbox), first, last)
    raise ValueError("Unknown dataset.")


@app.route("/")
def index():
    return send_from_directory("web", "index.html")


@app.route("/api/meta")
def meta():
    return jsonify(firedata.collection_ranges())


@app.after_request
def no_stale_files(response):
    """The page and its scripts change together; never let a browser mix versions."""
    if not request.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-cache"
    return response


@app.after_request
def compress(response):
    """Gzip JSON: the week of live detections is ~10 MB raw, ~2 MB gzipped."""
    if (response.mimetype == "application/json" and response.status_code == 200
            and "gzip" in request.headers.get("Accept-Encoding", "")
            and not response.direct_passthrough and response.content_length and response.content_length > 2048):
        response.set_data(gzip.compress(response.get_data(), compresslevel=5))
        response.headers["Content-Encoding"] = "gzip"
        response.headers["Vary"] = "Accept-Encoding"
    return response


def guarded(load):
    try:
        return jsonify(load())
    except ValueError as error:
        return jsonify({"error": str(error)}), 400
    except Exception as error:
        traceback.print_exc()
        return jsonify({"error": f"Could not load this dataset ({error})."}), 502


@app.route("/api/live")
def live():
    return guarded(lambda: firedata.live_fires(request.args.get("window", "24h")))


@app.route("/api/incidents")
def incidents():
    return guarded(lambda: firedata.live_incidents())


@functools.lru_cache(maxsize=32)
def cached_calendar(bbox):
    return firedata.fire_calendar(list(bbox))


@app.route("/api/calendar")
def calendar():
    return guarded(lambda: cached_calendar(tuple(firedata.parse_bbox(request.args))))


@functools.lru_cache(maxsize=64)
def cached_spread(bbox, updated):
    return firedata.likely_spread(list(bbox))


@app.route("/api/spread")
def spread():
    def load():
        w, s, e, n = firedata.parse_bbox(request.args)
        # Snap outward to 0.05° so small pans reuse the same result.
        snap = lambda x, f: round(f(x / 0.05) * 0.05, 2)
        bbox = (snap(w, math.floor), snap(s, math.floor), snap(e, math.ceil), snap(n, math.ceil))
        # Keyed on the FIRMS update time: new detections give a new answer.
        return cached_spread(bbox, firedata.live_fires("48h")["updated"])
    return guarded(load)


@app.route("/api/<kind>")
def api(kind):
    try:
        bbox, start, end = firedata.parse_request(request.args)
        extra = None
        if kind == "baseline":
            extra = min(max(int(request.args.get("years", 5)), 1), 10)
        elif kind == "severity":
            last = int(request.args.get("last", end.year))
            first = int(request.args.get("first", last - 15))
            extra = (first, last)
        return jsonify(cached(kind, tuple(bbox), start, end, extra))
    except ValueError as error:
        return jsonify({"error": str(error)}), 400
    except Exception as error:
        traceback.print_exc()
        return jsonify({"error": f"Could not load this dataset ({error})."}), 502


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=8765, threaded=True)
