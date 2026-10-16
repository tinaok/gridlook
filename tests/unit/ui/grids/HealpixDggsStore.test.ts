/**
 * Healpix.vue on the level-12 node of a GRID4EARTH Sentinel-2 store, read
 * through the real ZarrDataManager: the `crs` has `refinement_level` but no
 * `healpix_nside`, the cells are a `numcodecs.delta` coordinate and the
 * reflectances are `hcc-sentinel2-pyramid`. Only the rendering and the workers
 * are replaced.
 */
import "@/utils/disposablePolyfill.ts";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  Ellipsoid,
  Grid,
  type EllipsoidInput,
  type GridOptions,
} from "healpix-geo";
import * as THREE from "three";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { effectScope } from "vue";

import type { TSources } from "@/lib/types/GlobeTypes.ts";

type THoverLookup = (
  lat: number,
  lon: number
) => { value: number | null } | null;

const { beforeMount, scene, hover, faces, logError } = vi.hoisted(() => ({
  beforeMount: [] as (() => Promise<void>)[],
  scene: { current: undefined as unknown },
  hover: { lookup: null as THoverLookup | null },
  faces: [] as { grid: GridOptions; data: Float32Array; cells?: number[] }[],
  logError: vi.fn(),
}));

vi.stubGlobal("localStorage", { getItem: () => null });
vi.mock("vue", async (original) => ({
  ...(await original<typeof import("vue")>()),
  onBeforeMount: (callback: () => Promise<void>) => beforeMount.push(callback),
  onBeforeUnmount: vi.fn(),
  useSSRContext: () => ({}),
}));
vi.mock("@/ui/common/useLog.ts", () => ({ useLog: () => ({ logError }) }));
vi.mock("@/ui/grids/composables/gridHoverUtils.ts", () => ({
  useGridHoverLookup: () => ({
    clearHoverLookup: () => {
      hover.lookup = null;
    },
    setHoverLookup: (lookup: THoverLookup) => {
      hover.lookup = lookup;
    },
  }),
}));
vi.mock("@/ui/grids/composables/useGridCameraState.ts", () => ({
  useGridCameraState: vi.fn(),
}));
vi.mock("@/ui/grids/composables/useGridScene.ts", async () => {
  const { ref } = await import("vue");
  return {
    useGridScene: () => ({
      getScene: () => scene.current,
      getRenderer: () => undefined,
      redraw: vi.fn(),
      fitCameraToDataset: vi.fn(),
      hoveredGeoPoint: ref(null),
    }),
  };
});
vi.mock("@/ui/grids/composables/useGridOverlays.ts", () => ({
  getLayerRenderOrder: () => 0,
  useGridOverlays: () => ({
    updateLandSeaMask: vi.fn(),
    updateTextureLayers: vi.fn(),
  }),
}));
// The grid data worker's read, on this thread.
vi.mock("@/lib/grids/gridDataWorkerClient.ts", async () => {
  const { ZarrDataManager } = await import("@/lib/data/ZarrDataManager.ts");
  return {
    getGridVariableData: async (request: {
      source: Parameters<typeof ZarrDataManager.getVariableInfo>[0];
      variable: string;
      selection: Parameters<typeof ZarrDataManager.getVariableData>[2];
    }) =>
      (
        await ZarrDataManager.getVariableData(
          request.source,
          request.variable,
          request.selection
        )
      ).data,
    terminateGridDataWorker: vi.fn(),
  };
});
// The face builder's worker, run in place.
vi.mock("@/lib/grids/healpixWorkerClient.ts", async () => {
  const healpix = await import("healpix-geo");
  const { buildHealpixGeometry, buildHealpixTexture } =
    await import("@/lib/grids/healpixCalculations.ts");
  const { ProjectionHelper } =
    await import("@/lib/projection/projectionUtils.ts");
  return {
    terminateHealpixWorker: vi.fn(),
    buildHealpixFace: async (request: {
      grid: GridOptions;
      faceIndex: number;
      data: Float32Array;
      cells?: number[];
      projectionType: ConstructorParameters<typeof ProjectionHelper>[0];
      projectionCenter: ConstructorParameters<typeof ProjectionHelper>[1];
    }) => {
      faces.push(request);
      using grid = new healpix.Grid(request.grid);
      const texture = buildHealpixTexture(
        request.data,
        request.faceIndex,
        grid.nside,
        request.cells
      );
      using face = grid.replace({ level: 0, scheme: "nested" });
      return {
        batchIndex: request.faceIndex,
        ...buildHealpixGeometry(
          face,
          BigInt(request.faceIndex),
          9,
          new ProjectionHelper(request.projectionType, request.projectionCenter)
        ),
        ...texture,
      };
    },
  };
});

const { createPinia, setActivePinia } = await import("pinia");
const { setJxlWasmSource } = await import("@/lib/data/codecs/hcc/jxl.ts");
const { getGridType, GRID_TYPES } =
  await import("@/lib/data/gridTypeDetector.ts");
const { indexFromZarr } = await import("@/lib/data/sourceIndexing.ts");
const { ZarrDataManager } = await import("@/lib/data/ZarrDataManager.ts");
const { useGlobeControlStore } = await import("@/store/store.ts");
const { default: Healpix } = await import("@/ui/grids/Healpix.vue");

const FIXTURES = fileURLToPath(
  new URL("../../lib/data/codecs/hcc/__fixtures__/", import.meta.url)
);
const SRC = "https://example.test/s2_l12.zarr";

function requestUrl(input: RequestInfo | URL) {
  return input instanceof Request ? input.url : String(input);
}

type TFiles = Map<string, Uint8Array<ArrayBuffer>>;

/** Add the files of `dir` to `files`, keyed by their URL below `base`. */
function readDirectory(base: string, dir: string, files: TFiles = new Map()) {
  for (const entry of readdirSync(dir)) {
    const file = join(dir, entry);
    if (statSync(file).isDirectory()) {
      readDirectory(`${base}/${entry}`, file, files);
    } else {
      files.set(`${base}/${entry}`, new Uint8Array(readFileSync(file)));
    }
  }
  return files;
}

/** Serve `files` by URL; anything else is a 404. */
function serve(files: TFiles) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const file = files.get(requestUrl(input));
    return file ? new Response(file) : new Response(null, { status: 404 });
  });
}

beforeAll(() => {
  // Node cannot fetch the Vite asset URL: hand the WASM bytes over
  const require = createRequire(import.meta.url);
  setJxlWasmSource(
    readFileSync(
      join(
        require.resolve("jxl-oxide-wasm/package.json"),
        "..",
        "jxl_oxide_wasm_bg.wasm"
      )
    )
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  ZarrDataManager.invalidateCache();
});

async function mount(sources: TSources, variable: string) {
  beforeMount.length = 0;
  faces.length = 0;
  hover.lookup = null;
  logError.mockClear();
  setActivePinia(createPinia());
  useGlobeControlStore().varnameSelector = variable;
  scene.current = new THREE.Scene();
  const scope = effectScope();
  scope.run(() =>
    Healpix.setup!(
      { datasources: sources },
      { expose: vi.fn(), attrs: {}, slots: {}, emit: vi.fn() }
    )
  );
  await beforeMount[0]();
  expect(logError).not.toHaveBeenCalled();
  return scope;
}

function readJson<T>(name: string) {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as T;
}

function readFloat64(name: string) {
  return new Float64Array(
    new Uint8Array(readFileSync(join(FIXTURES, name))).buffer
  );
}

it("draws a store without healpix_nside at its DGGS refinement level", async () => {
  serve(readDirectory(SRC, join(FIXTURES, "store_L12")));
  const sources = await indexFromZarr(SRC);
  expect(await getGridType(true, "b04", sources, logError)).toBe(
    GRID_TYPES.HEALPIX
  );
  // no Easygems `healpix_nside`: the grid has to come from the DGGS metadata
  const crs = await ZarrDataManager.getCRSInfo(sources, "b04");
  expect(crs.attrs.healpix_nside).toBeUndefined();
  const scope = await mount(sources, "b04");

  // the grid of every face is the DGGS one: level 12 on the WGS84 ellipsoid
  const { dggs } = readJson<{
    attributes: { dggs: { ellipsoid: EllipsoidInput } };
  }>("store_L12/zarr.json").attributes;
  using wgs84 = Ellipsoid.from(dggs.ellipsoid);
  expect(faces.length).toBeGreaterThan(0);
  for (const face of faces) {
    expect(face.grid).toMatchObject({ scheme: "nested", level: 12 });
    using ellipsoid = Ellipsoid.from(face.grid.ellipsoid);
    expect(ellipsoid.semiMajorAxis).toBe(wgs84.semiMajorAxis);
    expect(ellipsoid.flattening).toBeCloseTo(wgs84.flattening, 12);
  }
  const cells = readJson<number[]>("store_L12_cell_ids.expected.json");
  const drawn = faces.flatMap((face) => face.cells ?? []);
  expect(drawn.sort((a, b) => a - b)).toEqual(cells);

  // hover reads the decoded reflectance of the cell under the pointer
  const expected = readFloat64("real_L12_b04_0.expected.f64");
  const index = expected.findIndex((value) => !Number.isNaN(value));
  using grid = new Grid(faces[0].grid);
  const [lon, lat] = grid.healpixToLonLat(
    BigUint64Array.of(BigInt(cells[index]))
  );
  expect(hover.lookup!(lat, lon)!.value).toBeCloseTo(expected[index], 6);
  scope.stop();
});
