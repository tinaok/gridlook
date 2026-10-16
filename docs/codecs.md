# Compression codecs

Gridlook reads Zarr arrays with [zarrita](https://github.com/manzt/zarrita.js)
and registers further decoders in `src/lib/data/codecs.ts`, so that they work
on the main thread and in the workers that read data.

## Sentinel-2 reflectances (`hcc-sentinel2-pyramid`, `hcc-sentinel2`)

The GRID4EARTH Sentinel-2 L2A HEALPix products store their reflectance bands
with the Zarr v3 serializers of
[healpix-compress](https://github.com/jmdelouis/healpix-compress):
`hcc-sentinel2-pyramid` (lossy: the parent level as lossless digital numbers,
the children predicted from it plus a quantised detail, all JPEG XL coded) and
`hcc-sentinel2` (lossless digital numbers in JPEG XL). Their decoders are in
`src/lib/data/codecs/hcc/`. JPEG XL is decoded by
[jxl-oxide-wasm](https://github.com/tirr-c/jxl-oxide), loaded on first use
only; no-data cells come out as `NaN`, so they render transparent. The codecs
are decode-only.

The decoders are tested against vectors produced by the Python reference
implementation (`npm test`); `scripts/make_hcc_fixtures.py` regenerates them
into `tests/unit/lib/data/codecs/hcc/__fixtures__/` from a Python environment
where `hcc` (healpix-compress) and `imagecodecs` are installed. The real
chunks and the level-12 nodes come from the GRID4EARTH test store on S3, which
also needs `s3fs`, `zarr` and an AWS profile named `grid4earth` that can read
it. Without that access, run the script with `--no-s3`: it fetches nothing and
decodes the real chunks already in the fixtures again, so that they stay in
`manifest.json`.
