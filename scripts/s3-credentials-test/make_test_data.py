"""Tiny HEALPix (nside 64, nested) test stores: Zarr v3, Icechunk, Kerchunk refs."""
import json
import pathlib
import sys

import icechunk
import numpy as np
import xarray as xr

out = pathlib.Path(sys.argv[1])
bucket = sys.argv[2]
endpoint = "https://s3.gra.io.cloud.ovh.net"
nside = 64
npix = 12 * nside**2

# Smooth synthetic field that varies with the nested pixel index and time.
cell = np.arange(npix)
face = cell // nside**2
local = (cell % nside**2) / nside**2
data = np.stack([np.sin(2 * np.pi * (face / 12 + local) + t) for t in range(2)]).astype("float32")

ds = xr.Dataset(
    {
        "signal": (("time", "cell"), data, {"grid_mapping": "crs", "long_name": "synthetic test signal", "units": "1"}),
        "crs": ((), np.int8(0), {"grid_mapping_name": "healpix", "healpix_nside": nside, "healpix_order": "nest"}),
    },
    coords={"time": np.array(["2026-11-01", "2026-11-02"], dtype="datetime64[ns]")},
    attrs={"title": "Gridlook S3-credentials test store (synthetic, nside 64)"},
)
enc = {"signal": {"chunks": (1, 4096)}}

zarr_path = out / "zarr" / "test.zarr"
ds.to_zarr(zarr_path, mode="w", zarr_format=3, consolidated=False, encoding=enc)

repo = icechunk.Repository.create(icechunk.local_filesystem_storage(str(out / "icechunk" / "test.icechunk")))
session = repo.writable_session("main")
ds.to_zarr(session.store, mode="w", zarr_format=3, consolidated=False, encoding=enc)
session.commit("synthetic test data")

# Kerchunk v1 refs: metadata inline, every other file referenced whole.
def refs(prefix):
    r = {}
    for f in sorted(p for p in zarr_path.rglob("*") if p.is_file()):
        key = f.relative_to(zarr_path).as_posix()
        if f.name == "zarr.json":
            r[key] = f.read_text()
        else:
            r[key] = [f"{prefix}/zarr/test.zarr/{key}", 0, f.stat().st_size]
    return {"version": 1, "refs": r}

(out / "kerchunk").mkdir(exist_ok=True)
for name, prefix in {"test-s3.json": f"s3://{bucket}", "test-https.json": f"{endpoint}/{bucket}"}.items():
    (out / "kerchunk" / name).write_text(json.dumps(refs(prefix)))
print("ok", npix, "cells")
