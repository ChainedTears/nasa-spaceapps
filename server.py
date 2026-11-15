"""
Web UI for the fire scripts.

    python3 server.py        then open http://localhost:8765

Serves the page in web/ and four JSON endpoints backed by firedata.py.
"""

import functools
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
