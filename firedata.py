"""
Harmonized loaders for the web UI (server.py).

These are the same queries as the four command-line scripts, but with the
area and dates passed in instead of typed in / hard-coded:

    data.py / burnedmonthly.py -> modis_fires()      MODIS 8-day FireMask
                                  modis_baseline()   same season, earlier years
    radiative.py               -> radiative_power()  Sentinel-3 SLSTR FRP
    burnseverity.py            -> burn_severity()    MTBS yearly mosaics
    (live)                     -> live_fires()       NASA FIRMS VIIRS, last 24 h to 7 days
                                  live_incidents()   NASA EONET named wildfires
    (calendar)                 -> fire_calendar()    MODIS MCD64A1 burned area by month

Everything comes back as plain dicts/lists on a shared (lat, lon, time)
footing so the browser can overlay and compare the records directly.
"""

import csv
import io
import json
import math
import threading
import time
import traceback
import warnings
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import odc.stac
import planetary_computer
import pystac_client
import requests
import xarray as xr

warnings.filterwarnings("ignore")

STAC_URL = "https://planetarycomputer.microsoft.com/api/stac/v1"
CACHE_DIR = Path(__file__).parent / "output" / "cache"
CACHE_DIR.mkdir(parents=True, exist_ok=True)

FIRE_MIN = 7            # FireMask 7/8/9 = fire (low/nominal/high confidence)
CLOUD = 4               # FireMask 4 = cloud
MAX_PASSES = 500        # most Sentinel-3 passes downloaded for one request
MAX_SPAN = 8.0          # largest box side, in degrees

SEVERITY_CLASSES = {
    1: "unburned to low",
    2: "low",
    3: "moderate",
    4: "high",
    5: "increased greenness",
}

_local = threading.local()


def catalog():
    """One STAC client per thread (the client is not thread-safe)."""
    if not hasattr(_local, "catalog"):
        _local.catalog = pystac_client.Client.open(
            STAC_URL, modifier=planetary_computer.sign_inplace
        )
    return _local.catalog


def check_bbox(bbox):
    west, south, east, north = bbox
    if not (-180 <= west < east <= 180 and -90 <= south < north <= 90):
        raise ValueError("The area must be west<east and south<north, in degrees.")
    if east - west > MAX_SPAN or north - south > MAX_SPAN:
        raise ValueError(f"Please keep the area under {MAX_SPAN:g} degrees on a side.")


def grid_resolution(bbox, finest, max_pixels):
    """Degrees per pixel: `finest` for small boxes, coarser for big ones."""
    span = max(bbox[2] - bbox[0], bbox[3] - bbox[1])
    return round(max(finest, span / max_pixels), 5)


def pixel_area_km2(bbox, resolution):
    mid_lat = math.radians((bbox[1] + bbox[3]) / 2)
    return (resolution * 111.32) ** 2 * math.cos(mid_lat)


def collection_ranges():
    """First/last date each collection covers, for the UI's hints."""
    out = {}
    for key, name in [
        ("fires", "modis-14A2-061"),
        ("radiative", "sentinel-3-slstr-frp-l2-netcdf"),
        ("severity", "mtbs"),
    ]:
        interval = catalog().get_collection(name).extent.temporal.intervals[0]
        out[key] = [d.date().isoformat() if d else None for d in interval]
    return out


# --------------------------------------------------------------------------
# MODIS 8-day active fire (data.py, burnedmonthly.py)
# --------------------------------------------------------------------------

def _modis_grid(bbox, start, end, resolution):
    """FireMask per 8-day window (Terra and Aqua merged), or None if no data."""
    items = catalog().search(
        collections=["modis-14A2-061"], bbox=bbox, datetime=f"{start}/{end}",
    ).item_collection()
    if len(items) == 0:
        return None
    data = odc.stac.load(
        items, crs="EPSG:4326", bbox=bbox, bands=["FireMask"],
        resolution=resolution, groupby="id", chunks={},
    ).compute(scheduler="threads", num_workers=16)
    # Terra and Aqua each have one item per window: keep the highest class.
    return data["FireMask"].groupby("time").max().sortby("time")


def _window_index(day):
    """MODIS 8-day windows restart every 1 January: 0, 1, ... 45."""
    return (date.fromisoformat(day).timetuple().tm_yday - 1) // 8


def modis_fires(bbox, start, end):
    check_bbox(bbox)
    resolution = grid_resolution(bbox, 0.01, 500)
    grid = _modis_grid(bbox, start, end, resolution)
    result = {
        "resolution": resolution,
        "pixel_km2": pixel_area_km2(bbox, resolution),
        "windows": [],
    }
    if grid is None:
        return result

    lats = grid["latitude"].values
    lons = grid["longitude"].values
    for t in grid["time"].values:
        values = grid.sel(time=t).values
        rows, cols = np.nonzero((values >= FIRE_MIN) & (values <= 9))
        day = str(t)[:10]
        result["windows"].append({
            "date": day,
            "win": _window_index(day),
            "cloud": round(float((values == CLOUD).mean()), 4),
            # [lat, lon, confidence 7|8|9]
            "pixels": [
                [round(float(lats[r]), 4), round(float(lons[c]), 4), int(values[r, c])]
                for r, c in zip(rows, cols)
            ],
        })
    return result


def _shift_year(day, years):
    try:
        return day.replace(year=day.year - years)
    except ValueError:  # 29 February
        return day.replace(year=day.year - years, day=28)


def modis_baseline(bbox, start, end, years=5):
    """Fire-pixel counts for the same calendar period in earlier years."""
    check_bbox(bbox)
    resolution = grid_resolution(bbox, 0.01, 500)

    def one_year(back):
        s, e = _shift_year(start, back), _shift_year(end, back)
        if s.year < 2001:
            return None
        grid = _modis_grid(bbox, s, e, resolution)
        counts = {}
        if grid is not None:
            for t in grid["time"].values:
                values = grid.sel(time=t).values
                counts[_window_index(str(t)[:10])] = int(
                    ((values >= FIRE_MIN) & (values <= 9)).sum()
                )
        return {"year": s.year, "counts": counts}

    with ThreadPoolExecutor(max_workers=years) as pool:
        results = list(pool.map(one_year, range(1, years + 1)))
    return {"years": [r for r in results if r]}


# --------------------------------------------------------------------------
# Sentinel-3 SLSTR fire radiative power (radiative.py)
# --------------------------------------------------------------------------

def _load_pass(item):
    """All fires in one satellite pass, cached on disk: [ms, lat, lon, frp, radiance]."""
    cache_file = CACHE_DIR / f"{item.id}.json"
    if cache_file.exists():
        return json.loads(cache_file.read_text())

    response = requests.get(item.assets["frp-in"].href, timeout=120)
    response.raise_for_status()
    with xr.open_dataset(io.BytesIO(response.content), engine="h5netcdf") as ds:
        count = ds.sizes.get("fires", 0)
        lat = ds["latitude"].values.ravel()
        lon = ds["longitude"].values.ravel()
        radiance = ds["F1_Fire_pixel_radiance"].values.ravel()
        frp = ds["FRP_MWIR"].values.ravel() if "FRP_MWIR" in ds else np.full(count, np.nan)
        if "time" in ds and count:
            ms = ds["time"].values.ravel().astype("datetime64[ms]").astype("int64")
        else:
            ms = np.full(count, int(item.datetime.timestamp() * 1000))

    def clean(x, digits):
        return round(float(x), digits) if np.isfinite(x) and x > 0 else None

    rows = [
        [int(ms[i]), round(float(lat[i]), 4), round(float(lon[i]), 4),
         clean(frp[i], 2), clean(radiance[i], 3)]
        for i in range(count)
        if np.isfinite(lat[i]) and np.isfinite(lon[i])
    ]
    cache_file.write_text(json.dumps(rows))
    return rows


def radiative_power(bbox, start, end):
    check_bbox(bbox)
    west, south, east, north = bbox
    items = list(catalog().search(
        collections=["sentinel-3-slstr-frp-l2-netcdf"], bbox=bbox,
        datetime=f"{start}T00:00:00Z/{end}T23:59:59Z",
    ).item_collection())
    items.sort(key=lambda item: item.datetime)
    total = len(items)
    if total > MAX_PASSES:  # keep an even spread across the whole period
        keep = np.linspace(0, total - 1, MAX_PASSES).round().astype(int)
        items = [items[i] for i in keep]

    def safe_load(item):
        try:
            return _load_pass(item)
        except Exception:  # one bad file shouldn't stop the run
            return None

    with ThreadPoolExecutor(max_workers=16) as pool:
        tables = list(pool.map(safe_load, items))

    # One pass covers a huge strip of land; keep only our box.
    fires = [
        row for table in tables if table for row in table
        if south <= row[1] <= north and west <= row[2] <= east
    ]
    fires.sort(key=lambda row: row[0])
    return {
        "passes": total,
        "passes_used": len(items),
        "passes_failed": sum(table is None for table in tables),
        "fires": fires,  # [time ms UTC, lat, lon, FRP MW, radiance]
    }


# --------------------------------------------------------------------------
# MTBS burn severity (burnseverity.py)
# --------------------------------------------------------------------------

def burn_severity(bbox, first_year, last_year):
    check_bbox(bbox)
    resolution = grid_resolution(bbox, 0.0025, 400)
    result = {
        "resolution": resolution,
        "pixel_km2": pixel_area_km2(bbox, resolution),
        "classes": SEVERITY_CLASSES,
        "years": [],
        "pixels": [],
    }
    items = catalog().search(
        collections=["mtbs"], bbox=bbox,
        datetime=f"{first_year}-01-01/{last_year}-12-31",
    ).item_collection()
    if len(items) == 0:
        return result

    data = odc.stac.load(
        items, crs="EPSG:4326", bbox=bbox, bands=["burn-severity"],
        resolution=resolution, groupby="id", chunks={},
    ).compute(scheduler="threads", num_workers=16)
    severity = data["burn-severity"].groupby("time").max().sortby("time")
    lats = severity["latitude"].values
    lons = severity["longitude"].values

    for t in severity["time"].values:
        values = np.nan_to_num(severity.sel(time=t).values).astype(int)
        year = int(str(t)[:4])
        counts = {str(code): int((values == code).sum()) for code in SEVERITY_CLASSES}
        if not any(counts.values()):
            continue
        result["years"].append({"year": year, "counts": counts})
        # Class 1 (unburned to low) is inside a fire perimeter but not
        # meaningfully burned, so it is counted above but not drawn.
        rows, cols = np.nonzero((values >= 2) & (values <= 5))
        result["pixels"].extend(
            [round(float(lats[r]), 4), round(float(lons[c]), 4), int(values[r, c]), year]
            for r, c in zip(rows, cols)
        )
    return result


def parse_request(args):
    """bbox + dates out of a query string, with friendly errors."""
    try:
        bbox = [float(x) for x in args["bbox"].split(",")]
        start = date.fromisoformat(args["start"])
        end = date.fromisoformat(args["end"])
    except (KeyError, ValueError):
        raise ValueError("Need bbox=west,south,east,north and start/end as YYYY-MM-DD.")
    if len(bbox) != 4:
        raise ValueError("bbox needs four numbers: west,south,east,north.")
    if end < start:
        start, end = end, start
    if end - start > timedelta(days=370):
        raise ValueError("Please keep the period to a year or less.")
    return [round(x, 4) for x in bbox], start, end


# --------------------------------------------------------------------------
# Live: NASA FIRMS VIIRS detections and EONET named incidents
# --------------------------------------------------------------------------

FIRMS_URL = "https://firms.modaps.eosdis.nasa.gov/data/active_fire/{folder}/csv/{prefix}_VIIRS_C2_Global_{window}.csv"
FIRMS_SATELLITES = [("noaa-20-viirs-c2", "J1", "NOAA-20"), ("noaa-21-viirs-c2", "J2", "NOAA-21")]
FIRMS_WINDOWS = ("24h", "48h", "7d")
EONET_URL = "https://eonet.gsfc.nasa.gov/api/v3/events"
LIVE_TTL = 600            # seconds a live download is reused
LIVE_CELL = {"24h": 0.005, "48h": 0.01, "7d": 0.02}   # degrees; detections in a cell are merged
CONFIDENCE = {"low": 0, "l": 0, "nominal": 1, "n": 1, "high": 2, "h": 2}

_live_cache = {}
_live_lock = threading.Lock()


def _cached(key, ttl, load):
    """Reuse a recent result; only one thread downloads a given key at a time."""
    with _live_lock:
        entry = _live_cache.get(key)
        if entry and time.time() - entry[0] < ttl:
            return entry[1]
        lock = _live_cache.setdefault(("lock", key), threading.Lock())
    with lock:
        entry = _live_cache.get(key)
        if entry and time.time() - entry[0] < ttl:
            return entry[1]
        value = load()
        _live_cache[key] = (time.time(), value)
        return value


def _firms_rows(folder, prefix, window):
    response = requests.get(FIRMS_URL.format(folder=folder, prefix=prefix, window=window), timeout=120)
    response.raise_for_status()
    reader = csv.DictReader(io.StringIO(response.text))
    rows = []
    for r in reader:
        try:
            hhmm = r["acq_time"].zfill(4)
            when = datetime.strptime(f"{r['acq_date']} {hhmm}", "%Y-%m-%d %H%M").replace(tzinfo=timezone.utc)
            rows.append((
                round(float(r["latitude"]), 3), round(float(r["longitude"]), 3),
                round(float(r["frp"] or 0), 1), int(when.timestamp() // 60),
                CONFIDENCE.get(r["confidence"].strip().lower(), 1), 1 if r["daynight"] == "N" else 0,
            ))
        except (KeyError, ValueError):
            continue
    return rows


def live_fires(window="24h"):
    """Every VIIRS fire detection worldwide in the last 24 h / 48 h / 7 days."""
    if window not in FIRMS_WINDOWS:
        raise ValueError("window must be 24h, 48h or 7d.")

    def load():
        used, rows = [], []
        with ThreadPoolExecutor(max_workers=len(FIRMS_SATELLITES)) as pool:
            jobs = {name: pool.submit(_firms_rows, folder, prefix, window) for folder, prefix, name in FIRMS_SATELLITES}
            for name, job in jobs.items():
                try:
                    rows.extend(job.result())
                    used.append(name)
                except Exception:   # one satellite's file missing shouldn't stop the other
                    traceback.print_exc()
        if not used:
            raise RuntimeError("NASA FIRMS did not answer")
        # Both satellites see the same fires and a fire is seen pass after pass:
        # merge detections into small cells, keeping the strongest reading,
        # the latest time and how many detections fell in the cell.
        cell = LIVE_CELL[window]
        cells = {}
        for row in rows:
            key = (round(row[0] / cell), round(row[1] / cell))
            c = cells.get(key)
            if c is None:
                cells[key] = [row[0], row[1], row[2], row[3], row[4], row[5], 1]
                continue
            c[6] += 1
            c[3] = max(c[3], row[3])
            c[4] = max(c[4], row[4])
            if row[2] > c[2]:
                c[0], c[1], c[2], c[5] = row[0], row[1], row[2], row[5]
        merged = sorted(cells.values(), key=lambda c: c[2])   # strongest drawn on top
        t0 = min((c[3] for c in merged), default=int(time.time() // 60))
        return {
            "window": window,
            "updated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "satellites": used,
            "detections": len(rows),
            "cell_deg": cell,
            "t0": t0 * 60000,      # ms UTC; each row's 4th value is minutes after this
            # [lat, lon, strongest FRP MW, latest: minutes after t0, best confidence 0|1|2, night 0|1, detections]
            "fires": [[a, b, c, t - t0, e, f, n] for a, b, c, t, e, f, n in merged],
        }

    return _cached(("firms", window), LIVE_TTL, load)


def live_incidents(days=30):
    """Named wildfires with an update in the last `days` days (EONET; mostly US IRWIN)."""

    def load():
        response = requests.get(EONET_URL, params={"category": "wildfires", "status": "open", "days": days}, timeout=60)
        response.raise_for_status()
        out = []
        for event in response.json().get("events", []):
            geometry = event.get("geometry") or []
            if not geometry:
                continue
            last = geometry[-1]
            coords = last.get("coordinates")
            if last.get("type") == "Polygon":
                ring = coords[0]
                coords = [sum(p[0] for p in ring) / len(ring), sum(p[1] for p in ring) / len(ring)]
            if not coords or len(coords) < 2:
                continue
            acres = last.get("magnitudeValue") if last.get("magnitudeUnit") == "acres" else None
            out.append({
                "id": event["id"],
                "title": event.get("title", "Wildfire"),
                "lon": round(coords[0], 4), "lat": round(coords[1], 4),
                "date": last.get("date"),
                "first": geometry[0].get("date"),
                "km2": round(acres * 0.0040468564, 2) if acres else None,
                "sources": [{"id": s.get("id"), "url": s.get("url")} for s in event.get("sources", [])],
            })
        out.sort(key=lambda e: e["date"] or "", reverse=True)
        return {"updated": datetime.now(timezone.utc).isoformat(timespec="seconds"), "days": days, "events": out}

    return _cached(("eonet", days), LIVE_TTL, load)


# --------------------------------------------------------------------------
# Fire calendar: what has burned here in each month, from MODIS MCD64A1
# --------------------------------------------------------------------------

CALENDAR_TTL = 20 * 86400   # new months arrive roughly monthly
MAX_CALENDAR_PIXELS = 120_000


def fire_calendar(bbox):
    """Burned area per month and week for every year since 2001, plus where it burned."""
    check_bbox(bbox)
    key = "calendar_" + "_".join(f"{x:.2f}" for x in bbox)
    cache_file = CACHE_DIR / f"{key}.json"
    if cache_file.exists() and time.time() - cache_file.stat().st_mtime < CALENDAR_TTL:
        return json.loads(cache_file.read_text())

    resolution = grid_resolution(bbox, 0.01, 250)
    km2 = pixel_area_km2(bbox, resolution)
    items = catalog().search(
        collections=["modis-64A1-061"], bbox=bbox,
        datetime=f"2001-01-01/{date.today().isoformat()}",
    ).item_collection()
    if len(items) == 0:
        raise ValueError("No MODIS burned-area record covers this place.")

    data = odc.stac.load(
        items, crs="EPSG:4326", bbox=bbox, bands=["Burn_Date"],
        resolution=resolution, groupby="id", chunks={},
    ).compute(scheduler="threads", num_workers=32)
    # One item per month per MODIS tile: keep, per pixel, whichever tile mapped it.
    burn = data["Burn_Date"].groupby("time").max().sortby("time")
    lats = burn["latitude"].values
    lons = burn["longitude"].values

    months_seen = set()
    monthly, weekly, pixels = {}, {}, []
    for t in burn["time"].values:
        stamp = str(t)[:10]
        year, month = int(stamp[:4]), int(stamp[5:7])
        months_seen.add((year, month))
        monthly.setdefault(year, [0.0] * 12)
        weekly.setdefault(year, [0.0] * 53)
        values = np.nan_to_num(burn.sel(time=t).values).astype(int)
        rows, cols = np.nonzero((values >= 1) & (values <= 366))
        if not len(rows):
            continue
        days = values[rows, cols]
        # Burn_Date is the day of year it burned; place each pixel by its own day.
        for doy in np.unique(days):
            n = int((days == doy).sum())
            when = date(year, 1, 1) + timedelta(days=int(doy) - 1)
            monthly[year][when.month - 1] += n * km2
            weekly[year][min((int(doy) - 1) // 7, 52)] += n * km2
        pixels.extend(
            [round(float(lats[r]), 4), round(float(lons[c]), 4), year, int(d)]
            for r, c, d in zip(rows, cols, days)
        )

    if len(pixels) > MAX_CALENDAR_PIXELS:   # keep an even sample for drawing
        step = len(pixels) / MAX_CALENDAR_PIXELS
        pixels = [pixels[int(i * step)] for i in range(MAX_CALENDAR_PIXELS)]

    years = sorted(monthly)
    result = {
        "bbox": bbox,
        "resolution": resolution,
        "pixel_km2": km2,
        "area_km2": round((bbox[2] - bbox[0]) * (bbox[3] - bbox[1]) * 111.32 ** 2 * math.cos(math.radians((bbox[1] + bbox[3]) / 2)), 1),
        "years": years,
        "first": "%d-%02d" % min(months_seen),
        "last": "%d-%02d" % max(months_seen),
        # Months with no MODIS file yet (the recent ones) are null, not zero.
        "monthly": {str(y): [round(v, 3) if (y, m + 1) in months_seen else None for m, v in enumerate(monthly[y])] for y in years},
        "weekly": {str(y): [round(v, 3) for v in weekly[y]] for y in years},
        "pixels": pixels,     # [lat, lon, year, day of year]
        "sampled": len(pixels) == MAX_CALENDAR_PIXELS,
    }
    cache_file.write_text(json.dumps(result))
    return result


def parse_bbox(args):
    try:
        bbox = [float(x) for x in args["bbox"].split(",")]
    except (KeyError, ValueError):
        raise ValueError("Need bbox=west,south,east,north.")
    if len(bbox) != 4:
        raise ValueError("bbox needs four numbers: west,south,east,north.")
    return [round(x, 4) for x in bbox]
