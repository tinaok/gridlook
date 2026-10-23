/**
 * zarrita codecs for the healpix-compress Sentinel-2 serializers
 * `hcc-sentinel2-pyramid` (lossy: lossless parent level, predicted and
 * quantised children) and `hcc-sentinel2` (lossless digital numbers), both
 * JPEG XL based, decode-only. `src/lib/data/codecs.ts` registers them.
 *
 * Reference implementation: https://github.com/GRID4EARTH/healpix-compress
 * (`hcc/compression/sentinel2_pyramid.py`, `hcc/compression/sentinel2.py`).
 */
import type { Chunk, DataType } from "zarrita";

import {
  allocate,
  cStrides,
  decodeLosslessRow,
  decodeRows,
  isFloatDataType,
  readQuantisation,
  rowDepth,
  type TFloatArray,
  type TFloatDataType,
  type THccSentinel2Configuration,
  type TQuantisation,
} from "./sentinel2.ts";
import {
  decodePyramidRow,
  type THccSentinel2PyramidConfiguration,
} from "./sentinel2Pyramid.ts";

export const HCC_SENTINEL2_PYRAMID = "hcc-sentinel2-pyramid";
export const HCC_SENTINEL2 = "hcc-sentinel2";

/**
 * What zarrita hands to `fromConfig` (its `ChunkMetadata`, not exported):
 * the array's data type and chunk shape are all the codecs need.
 */
export interface TCodecMeta {
  dataType: DataType;
  shape: number[];
}

type TRowDecoder = (
  stream: Uint8Array,
  quantisation: TQuantisation,
  out: TFloatArray,
  offset: number,
  size: number
) => Promise<void>;

/** What both codecs share: the chunk shape, the output dtype and the row container. */
abstract class HccSentinel2Base {
  readonly kind = "array_to_bytes";
  protected readonly shape: number[];
  protected readonly dataType: TFloatDataType;
  protected readonly quantisation: TQuantisation;

  constructor(
    name: string,
    configuration: THccSentinel2Configuration | undefined,
    meta: TCodecMeta,
    protected readonly decodeRow: TRowDecoder
  ) {
    if (!isFloatDataType(meta.dataType)) {
      throw new Error(
        `${name} stores reflectances as float32 or float64, got ${meta.dataType}`
      );
    }
    if (meta.shape.length === 0) {
      throw new Error(`${name}: expected a chunk with at least one axis`);
    }
    rowDepth(meta.shape[meta.shape.length - 1], name);
    this.shape = [...meta.shape];
    this.dataType = meta.dataType;
    this.quantisation = readQuantisation(configuration);
  }

  async decode(bytes: Uint8Array): Promise<Chunk<TFloatDataType>> {
    const size = this.shape.reduce((a, b) => a * b, 1);
    const data = allocate(this.dataType, size);
    const rowSize = this.shape[this.shape.length - 1];
    await decodeRows(
      bytes,
      this.shape,
      (stream, out, offset) =>
        this.decodeRow(stream, this.quantisation, out, offset, rowSize),
      data
    );
    return { data, shape: this.shape, stride: cStrides(this.shape) };
  }

  encode(): never {
    throw new Error("the hcc Sentinel-2 codecs are decode-only in Gridlook");
  }
}

export class HccSentinel2PyramidCodec extends HccSentinel2Base {
  static fromConfig(
    configuration: unknown,
    meta: TCodecMeta
  ): HccSentinel2PyramidCodec {
    return new HccSentinel2PyramidCodec(
      configuration as THccSentinel2PyramidConfiguration | undefined,
      meta
    );
  }

  constructor(
    configuration: THccSentinel2PyramidConfiguration | undefined,
    meta: TCodecMeta
  ) {
    super(HCC_SENTINEL2_PYRAMID, configuration, meta, decodePyramidRow);
  }
}

export class HccSentinel2Codec extends HccSentinel2Base {
  static fromConfig(
    configuration: unknown,
    meta: TCodecMeta
  ): HccSentinel2Codec {
    return new HccSentinel2Codec(
      configuration as THccSentinel2Configuration | undefined,
      meta
    );
  }

  constructor(
    configuration: THccSentinel2Configuration | undefined,
    meta: TCodecMeta
  ) {
    super(HCC_SENTINEL2, configuration, meta, decodeLosslessRow);
  }
}
