"""
Ask for a time range, then find every fire pixel in the MODIS 8-day fire data
(modis-14A2-061) inside a box around LOCATION.

The results go into two parallel lists:
    fire_dates[i]     -> date of the 8-day window the fire was seen in
    fire_locations[i] -> (latitude, longitude) of that fire pixel
"""

import warnings
from datetime import date

import numpy as np
import odc.stac
import planetary_computer
import pystac_client

warnings.filterwarnings("ignore")

# Center of the search box. This is near where the 2021 Dixie Fire started.
LATITUDE = 40.0
LONGITUDE = -121.4
BUFFER = 1.0          # degrees on each side of the center (~220 x 170 km box)
RESOLUTION = 0.01     # degrees per pixel (~1 km, MODIS's native resolution)
FIRE_MIN = 7          # FireMask 7/8/9 = fire (low/nominal/high confidence)


def ask_date(prompt):
    while True:
        text = input(prompt).strip()
        try:
            return date.fromisoformat(text)
        except ValueError:
            print("  Please use the format YYYY-MM-DD, e.g. 2021-07-20")


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
        collections=["modis-14A2-061"],
        bbox=bbox,
        datetime=f"{start}/{end}",
    ).item_collection()

    fire_dates = []
    fire_locations = []

    if len(items) == 0:
        print("No MODIS data found for that time range.")
        return fire_dates, fire_locations

    print(f"Found {len(items)} MODIS items, loading pixels...")

    # Load every item separately (Terra and Aqua satellites each have one per
    # 8-day window), then keep the highest fire class seen per window.
    data = odc.stac.load(
        items,
        crs="EPSG:4326",
        bbox=bbox,
        bands="FireMask",
        resolution=RESOLUTION,
        groupby="id",
    )
    fire_mask = data["FireMask"].groupby("time").max()

    for t in fire_mask["time"].values:
        grid = fire_mask.sel(time=t).values
        rows, cols = np.nonzero((grid >= FIRE_MIN) & (grid <= 9))
        day = str(t)[:10]
        for r, c in zip(rows, cols):
            fire_dates.append(day)
            fire_locations.append((
                round(float(fire_mask["latitude"][r]), 4),
                round(float(fire_mask["longitude"][c]), 4),
            ))

    print(f"\nFound {len(fire_dates)} fire pixels.")
    for day in sorted(set(fire_dates)):
        print(f"  {day}: {fire_dates.count(day)} fire pixels")

    return fire_dates, fire_locations


if __name__ == "__main__":
    fire_dates, fire_locations = main()
    print("\nFirst few results:")
    for d, loc in list(zip(fire_dates, fire_locations))[:10]:
        print(f"  {d}  lat={loc[0]}, lon={loc[1]}")
