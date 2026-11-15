"""
Ask for a time range, then collect Sentinel-3 SLSTR fire radiative data
(sentinel-3-slstr-frp-l2-netcdf) for every fire detected inside a box
around LOCATION.

Everything ends up in one variable, `radiative_data` (a pandas DataFrame):
    time       when the satellite pass happened (UTC)
    latitude   fire location
    longitude  fire location
    radiance   F1_Fire_pixel_radiance
    frp_mwir   fire radiative power in megawatts (if the file has it)

Needs:  pip install h5netcdf   (xarray uses it to read the .nc files)
"""

import io
import warnings
from datetime import date

import pandas
import planetary_computer
import pystac_client
import requests
import xarray as xr

warnings.filterwarnings("ignore")

# Center of the search box. This is near where the 2021 Dixie Fire started.
LATITUDE = 40.0
LONGITUDE = -121.4
BUFFER = 1.0  # degrees on each side of the center

COLUMNS = ["time", "latitude", "longitude", "radiance", "frp_mwir"]


def ask_date(prompt):
    while True:
        text = input(prompt).strip()
        try:
            return date.fromisoformat(text)
        except ValueError:
            print("  Please use the format YYYY-MM-DD, e.g. 2021-07-20")


def load_item(item, bbox):
    """Download one satellite pass and return its fires inside bbox."""
    response = requests.get(item.assets["frp-in"].href, timeout=120)
    response.raise_for_status()
    with xr.open_dataset(io.BytesIO(response.content), engine="h5netcdf") as ds:
        table = pandas.DataFrame({
            "latitude": ds["latitude"].values.ravel(),
            "longitude": ds["longitude"].values.ravel(),
            "radiance": ds["F1_Fire_pixel_radiance"].values.ravel(),
        })
        if "FRP_MWIR" in ds:
            table["frp_mwir"] = ds["FRP_MWIR"].values.ravel()

    # One satellite pass covers a huge strip of land; keep only our box.
    west, south, east, north = bbox
    table = table.dropna(subset=["latitude", "longitude", "radiance"])
    table = table[
        table.latitude.between(south, north) & table.longitude.between(west, east)
    ]
    table.insert(0, "time", pandas.Timestamp(item.datetime))
    return table


def main():
    start = ask_date("Start date (YYYY-MM-DD): ")
    end = ask_date("End date   (YYYY-MM-DD): ")
    if end < start:
        start, end = end, start

    catalog = pystac_client.Client.open(
        "https://planetarycomputer.microsoft.com/api/stac/v1",
        modifier=planetary_computer.sign_inplace,
    )

    bbox = [LONGITUDE - BUFFER, LATITUDE - BUFFER, LONGITUDE + BUFFER, LATITUDE + BUFFER]
    items = catalog.search(
        collections=["sentinel-3-slstr-frp-l2-netcdf"],
        bbox=bbox,
        datetime=f"{start}/{end}",
    ).item_collection()
    print(f"Found {len(items)} satellite passes, downloading...")

    tables = []
    for n, item in enumerate(items, 1):
        print(f"  [{n}/{len(items)}] {item.datetime:%Y-%m-%d %H:%M}", end="")
        try:
            table = load_item(item, bbox)
        except Exception as error:  # one bad file shouldn't stop the run
            print(f"  skipped ({error})")
            continue
        print(f"  {len(table)} fires")
        tables.append(table)

    if tables:
        data = pandas.concat(tables, ignore_index=True)
        data = data.reindex(columns=COLUMNS).sort_values("time", ignore_index=True)
    else:
        data = pandas.DataFrame(columns=COLUMNS)

    print(f"\nTotal: {len(data)} fire detections")
    return data


if __name__ == "__main__":
    radiative_data = main()
    print(radiative_data.head(10))
