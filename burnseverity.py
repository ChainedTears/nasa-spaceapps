"""
Planetary Computer MTBS example notebook, with list output.

The notebook searches collection "mtbs" over the Carr Fire box and reads the
burn-severity mosaic. That search returns 35 yearly items (1984-2018). The
notebook plots the first one, which is 2018.

This script asks for a time range, loads the yearly mosaics those years touch,
and stores every mapped pixel in three parallel lists:
    burn_dates[i]     -> mosaic date (31 Dec of that year)
    burn_locations[i] -> (latitude, longitude)
    burn_classes[i]   -> (class code, class name)
"""

import warnings
from datetime import date

import numpy as np
import odc.stac
import planetary_computer
import pystac_client

warnings.filterwarnings("ignore")

# Axis-aligned Carr Fire box from the Planetary Computer MTBS example notebook.
WEST, SOUTH = -122.73925781250001, 40.50857873259441
EAST, NORTH = -122.33139038085936, 40.891715295571046
CARR_FIRE_AOI = {
    "type": "Polygon",
    "coordinates": [[
        [WEST, SOUTH],
        [EAST, SOUTH],
        [EAST, NORTH],
        [WEST, NORTH],
        [WEST, SOUTH],
    ]],
}
RESOLUTION = 0.01     # degrees per pixel (~1 km)
SEVERITY_MIN = 1      # 1-5 are mapped severity; 6 is a non-processing mask
SEVERITY_MAX = 5

CLASSES = {
    1: "unburned to low",
    2: "low",
    3: "moderate",
    4: "high",
    5: "increased greenness",
    6: "non-processing mask",
}


def ask_date(prompt):
    while True:
        text = input(prompt).strip()
        try:
            return date.fromisoformat(text)
        except ValueError:
            print("  Please use the format YYYY-MM-DD, e.g. 2018-01-01")


def main():
    start = ask_date("Start date (YYYY-MM-DD): ")
    end = ask_date("End date   (YYYY-MM-DD): ")
    if end < start:
        start, end = end, start

    catalog = pystac_client.Client.open(
        "https://planetarycomputer.microsoft.com/api/stac/v1",
        modifier=planetary_computer.sign_inplace,
    )

    # Same search as the notebook. The mosaic is dated 31 December, so the
    # search is widened to the whole years you typed.
    items = catalog.search(
        collections=["mtbs"],
        intersects=CARR_FIRE_AOI,
        datetime=f"{start.year}-01-01/{end.year}-12-31",
    ).item_collection()

    burn_dates = []
    burn_locations = []
    burn_classes = []

    if len(items) == 0:
        print(f"No MTBS mosaic for {start.year} through {end.year}.")
        print("The notebook's search, with no dates, returns 35 items (1984-2018).")
        return burn_dates, burn_locations, burn_classes

    print(
        f"Found {len(items)} yearly mosaic(s) for the Carr Fire box, "
        f"{start.year}-{end.year}."
    )
    print("Loading pixels...")

    bbox = [WEST, SOUTH, EAST, NORTH]
    data = odc.stac.load(
        items,
        crs="EPSG:4326",
        bbox=bbox,
        bands="burn-severity",
        resolution=RESOLUTION,
        groupby="id",
    )
    severity = data["burn-severity"]

    for t in severity["time"].values:
        grid = severity.sel(time=t).values
        rows, cols = np.nonzero((grid >= SEVERITY_MIN) & (grid <= SEVERITY_MAX))
        day = str(t)[:10]
        for r, c in zip(rows, cols):
            code = int(grid[r, c])
            burn_dates.append(day)
            burn_locations.append((
                round(float(severity["latitude"][r]), 4),
                round(float(severity["longitude"][c]), 4),
            ))
            burn_classes.append((code, CLASSES.get(code, "unknown")))

    print(f"\nFound {len(burn_dates)} burn-severity pixels.")
    for day in sorted(set(burn_dates)):
        print(f"  {day}: {burn_dates.count(day)} pixels")

    return burn_dates, burn_locations, burn_classes


if __name__ == "__main__":
    burn_dates, burn_locations, burn_classes = main()
    print("\nFirst few results:")
    for d, loc, klass in list(zip(burn_dates, burn_locations, burn_classes))[:10]:
        print(f"  {d}  lat={loc[0]}, lon={loc[1]}  class={klass[0]} {klass[1]}")
