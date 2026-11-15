# Credits

This project builds on the following outside data sources, APIs, services and libraries.

## Satellite and fire data

| Source | Provider | Used for | Where |
|---|---|---|---|
| [Microsoft Planetary Computer STAC API](https://planetarycomputer.microsoft.com/api/stac/v1) | Microsoft | Catalog search and signed access to all archive datasets below | `firedata.py`, `data.py`, `burnedmonthly.py`, `burnseverity.py`, `radiative.py` |
| MODIS Thermal Anomalies/Fire 8-Day (`modis-14A2-061`) | NASA LP DAAC, via Planetary Computer | Fire pixel detections and same-season baselines | `firedata.py`, `data.py`, `burnedmonthly.py` |
| MODIS Burned Area Monthly (`modis-64A1-061`, MCD64A1) | NASA LP DAAC, via Planetary Computer | Fire calendar (burned area by month) | `firedata.py` |
| Sentinel-3 SLSTR Fire Radiative Power L2 (`sentinel-3-slstr-frp-l2-netcdf`) | ESA / EUMETSAT Copernicus, via Planetary Computer | Fire radiative power per detection | `firedata.py`, `radiative.py` |
| Monitoring Trends in Burn Severity (`mtbs`) | USGS & USDA Forest Service, via Planetary Computer | Yearly burn-severity mosaics | `firedata.py`, `burnseverity.py` |
| ESA WorldCover 10 m land cover (`esa-worldcover`), CC BY 4.0 | ESA, via Planetary Computer | Burnable land and natural barriers for the likely-spread layer | `firedata.py` |
| [NASA FIRMS](https://firms.modaps.eosdis.nasa.gov/) active fire CSVs (VIIRS C2, NOAA-20 and NOAA-21) | NASA LANCE / FIRMS | Live global fire detections (24 h, 48 h, 7 days) | `firedata.py` |
| [NASA EONET API v3](https://eonet.gsfc.nasa.gov/api/v3/events) | NASA Earth Observatory | Live named wildfire incidents | `firedata.py` |

The Planetary Computer example notebook for MTBS was the starting point for `burnseverity.py`.

## Maps and imagery

| Source | Used for | Where |
|---|---|---|
| [NASA GIBS](https://gibs.earthdata.nasa.gov/) WMTS — MODIS Terra Corrected Reflectance True Color | Satellite basemap for the selected days | `web/app.js` |
| [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors (ODbL) | Map data; raster tiles from `tile.openstreetmap.org` | `web/app.js`, `web/index.html` |
| [OpenFreeMap](https://openfreemap.org) | Vector basemap styles (Positron, Dark), glyphs and sprites | `web/app.js` |
| Terrain Tiles (Terrarium) — Mapzen, hosted on [AWS Open Data](https://registry.opendata.aws/terrain-tiles/) | Elevation / terrain | `web/app.js` |
| [BigDataCloud](https://www.bigdatacloud.com/) client-side reverse geocoding API | Place names for coordinates | `web/app.js` |

## Front-end libraries and assets

| Library / asset | License | Where |
|---|---|---|
| [MapLibre GL JS](https://maplibre.org/) 5.6.0, loaded from unpkg | BSD-3-Clause | `web/index.html` |
| [Newsreader](https://fonts.google.com/specimen/Newsreader) typeface, via Google Fonts | SIL Open Font License | `web/index.html` |

## Python libraries

| Library | Used for |
|---|---|
| [Flask](https://flask.palletsprojects.com/) | Web server and JSON API (`server.py`) |
| [pystac-client](https://github.com/stac-utils/pystac-client) | STAC catalog search |
| [planetary-computer](https://github.com/microsoft/planetary-computer-sdk-for-python) | Signing Planetary Computer asset URLs |
| [odc-stac](https://github.com/opendatacube/odc-stac) | Loading STAC items into xarray |
| [xarray](https://xarray.dev/) + [h5netcdf](https://github.com/h5netcdf/h5netcdf) | Reading gridded and NetCDF data |
| [NumPy](https://numpy.org/) | Array processing |
| [pandas](https://pandas.pydata.org/) | Tabular FRP data (`radiative.py`) |
| [Requests](https://requests.readthedocs.io/) | HTTP downloads (FIRMS, EONET, NetCDF files) |
| [geogif](https://github.com/gjoseph92/geogif) | Animated GIF output (`data.py`) |
| [Rich](https://github.com/Textualize/rich) | Console tables (`data.py`) |

## Methods

- The likely-spread layer runs a cost-distance (Dijkstra) search outward from NASA FIRMS detections. It uses fuel weights per ESA WorldCover class, defined in `LAND_CLASSES` in `firedata.py`. This is the project's own simplification; it is not a published fire-spread model.
