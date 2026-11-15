from geogif import gif
import odc.stac
import planetary_computer
import pystac_client
import rich.table

catalog = pystac_client.Client.open(
    "https://planetarycomputer.microsoft.com/api/stac/v1",
    modifier=planetary_computer.sign_inplace,
)

# 2021 Dixie Wildfire in California
latitude = 40.7310
longitude = -122.9420
location = [longitude, latitude]
geometry = {
    "type": "Point",
    "coordinates": location,
}
datetimes = [
    "2021-07-12",
    "2021-07-20",
    # "2021-07-28",
    # "2021-08-05",
    # "2021-08-13",
    # "2021-08-21",
]

buffer = 0.1 # increases the range of the region covered when increased, 0.1 = 1 degree, ~160km
bbox = [longitude - buffer, latitude - buffer, longitude + buffer, latitude + buffer]
items = dict()

# Fetch the collection of interest and print available items
for datetime in datetimes:
    print(f"Fetching {datetime}")
    search = catalog.search(
        collections=["modis-14A2-061"],
        intersects=geometry,
        datetime=datetime,
    )
    items[datetime] = search.get_all_items()[0]

print(items)

data = odc.stac.load(
    items.values(),
    crs="EPSG:3857",
    bbox=bbox,
    bands="FireMask",
    resolution=100, # skips more places / generalizes the higher it is
)
data = data.where(data < 10, drop=True)
print(data)
