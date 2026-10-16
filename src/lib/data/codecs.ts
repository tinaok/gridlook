import { registerPCodec } from "@eeholmes/zarrita-pcodec";
import {
  Blosc2Codec,
  Fletcher32Codec,
  GribscanRawGribCodec,
  LogBinsCodec,
} from "codecita";
import { registry } from "zarrita";

import {
  HCC_SENTINEL2,
  HCC_SENTINEL2_PYRAMID,
  HccSentinel2Codec,
  HccSentinel2PyramidCodec,
} from "./codecs/hcc/index.ts";

registry.set("numcodecs.fletcher32", async () => Fletcher32Codec);
registry.set("numcodecs.gribscan.rawgrib", async () => GribscanRawGribCodec);
registry.set("numcodecs.log_bins", async () => LogBinsCodec);
registry.set("numcodecs.blosc2", async () => Blosc2Codec);
registry.set("blosc2", async () => Blosc2Codec);

// zarrita types its registry after numcodecs' bytes-to-bytes codecs, while an
// array_to_bytes codec decodes bytes into a chunk.
type TCodecEntry = Awaited<
  ReturnType<NonNullable<ReturnType<typeof registry.get>>>
>;
// healpix-compress Sentinel-2 reflectances; the JPEG XL decoder (WASM) is
// only loaded when a chunk is decoded
registry.set(
  HCC_SENTINEL2_PYRAMID,
  async () => HccSentinel2PyramidCodec as unknown as TCodecEntry
);
registry.set(
  HCC_SENTINEL2,
  async () => HccSentinel2Codec as unknown as TCodecEntry
);

registerPCodec(registry);
