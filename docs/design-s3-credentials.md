# Design: reading private S3 stores with S3 credentials

Status: design only, nothing implemented yet. Based on main `5641993`.

## Goal

Open Zarr, Icechunk and Kerchunk stores in buckets that need S3 credentials,
in our own bucket or in other people's buckets (any S3-compatible service,
e.g. AWS or OVHcloud). The keys stay in memory only, like the
advanced HTTP settings: never in the URL, a shared link or browser storage.

## How stores are read today

| Source | Code | Can the request be signed? |
| --- | --- | --- |
| Zarr v2/v3 | `ZarrDataManager.createNewStore` → `zarr.FetchStore(url, { fetch })` | Yes: replace the `fetch` option |
| Icechunk | `icechunkStore.ts` → `IcechunkStore.open(new HttpStorage(url, { headers, credentials }))` | No: `HttpStorage` only takes static headers and calls the global `fetch` |
| Icechunk virtual chunks | `IcechunkStoreOptions.fetchClient` | Yes |
| Kerchunk (`reference+…json`) | `referenceStore.ts` → plain `fetch(url)`, then `ReferenceStore.fromSpec(spec)` | Yes: `fromSpec(spec, { fetch })`. Note: the request settings (headers, cookies) do not reach Kerchunk today |

`s3://` URLs are not accepted as a store URL. Inside Kerchunk references,
zarrita maps `s3://` to `https://s3.amazonaws.com/…`, so other S3 services
cannot be reached.

## Options compared

SigV4 needs a new signature for every request, so a static header is not enough.

| Option | Changes in Gridlook | Icechunk | Key safety |
| --- | --- | --- | --- |
| (a) Sign in the browser (`aws4fetch`) | Medium | Needs a signing `Storage` | Secret in page memory only; use read-only, bucket-scoped keys |
| (b) Pre-signed URLs (e.g. a Kerchunk file of pre-signed URLs) | None | Not possible (keys are built inside icechunk-js) | The URLs are bearer tokens until they expire and end up in shared links |
| (c) Temporary credentials (STS) | Session token field for (a) | As (a) | Best way to hand out keys |
| (d) Signing gateway with its own auth | None (bearer token / headers already work) | Yes | Secret never reaches the browser; needs a server |
| (e) S3 support in icechunk-js | Wait for upstream | — | — |

Recommendation: (a) with **query signing** (`signQuery: true`) plus an
optional session token (c). Query signing adds no `Authorization` header, so
there is no extra CORS preflight for every chunk URL.

## Planned changes

1. `TRequestSettings` gets `s3?: { accessKeyId, secretAccessKey, sessionToken?, region, endpoint }`.
   It already goes to the worker with the other request settings.
2. New `src/lib/data/s3Signing.ts`: a signing `fetch` (one `AwsClient` per
   settings), `s3://bucket/key` → `<endpoint>/bucket/key` (path style), and a
   host check: **only requests to the configured endpoint are signed**.
3. `FetchStore`: use the signing `fetch`.
4. Icechunk: `SignedHttpStorage implements Storage`, the same as
   `HttpStorage` (`getObject` with `Range: bytes=start-(end-1)`, `exists` with
   HEAD, `listPrefix` throws) but with the signing `fetch`; pass the signing
   fetch as `fetchClient` for virtual chunks.
5. Kerchunk: load the reference file and the chunks through the same `fetch`
   (this also passes the existing headers/cookies to Kerchunk).
6. Accept `s3://bucket/path` as a store URL; shared links keep only that URL.
7. UI: an "S3 credentials" part in the advanced HTTP settings (access key,
   secret as a password field, session token, region, endpoint). Not saved.
8. Tests: host check, `s3://` mapping, no keys in URLs or shared links, worker
   settings, Kerchunk signing, the 403 handling below.

About 350 lines with tests. Icechunk (step 4) can be a second PR.

### Errors from buckets without list permission

Without `s3:ListBucket`, S3 answers 403 (not 404) for a missing key, and
icechunk-js relies on 404 (`NotFoundError`) to probe the repository format.
So that other people's buckets work with read-only keys:

- The first read of a key that must exist fails with a clear credentials
  error (wrong key, expired token, clock skew).
- After one successful read, 403 is read as "not found".
- 400 is never read as "not found" (some services answer 400 to unsigned
  path-style requests).

### Known limitation

Only one set of keys. Icechunk virtual chunks (or Kerchunk references) on
another host that needs other keys cannot be read; public ones can. This has
to be written in the UI and in the docs.

### CORS on the bucket

Allowed origins = the Gridlook origins; methods GET, HEAD; headers `range`
(or `*`); expose `ETag`, `Content-Range`, `Content-Length`. When the bucket
answers `Access-Control-Allow-Headers: *`, the `withCredentials` (cookies)
setting must be off for S3 requests: the wildcard does not apply to requests
with credentials.

## Test setup

`scripts/s3-credentials-test/` makes a small HEALPix test store (nside 64,
nested, two time steps) as Zarr v3, Icechunk (native chunks) and two Kerchunk
files (`s3://` and `https://` references), plus the CORS rules and a
read-only bucket policy (`s3:GetObject` only, no list).

```bash
python make_test_data.py <out-dir> <bucket>
aws s3 sync <out-dir>/ s3://<bucket>/
aws s3api put-bucket-cors --bucket <bucket> --cors-configuration file://cors.json
```

Checked with curl on a private OVHcloud bucket (pre-signed with a key that
can list the bucket):

| Check | Result |
| --- | --- |
| Unsigned GET, path style | 400 `InvalidRequest` |
| Unsigned GET, virtual-host style | 403 |
| Preflight from an allowed origin | 200 with the allowed and exposed headers |
| Preflight from another origin | 403 |
| Pre-signed GET | 200 with `Access-Control-Allow-Origin` |
| Pre-signed GET with `Range: bytes=-100` | 206, 100 bytes (suffix ranges work) |
| Pre-signed GET of a missing key | 404 |

Still to check in the browser with the read-only key: 403 for a missing key.

## Later

- An icechunk-js PR adding a `fetch` option to `HttpStorageOptions` would
  replace `SignedHttpStorage`. To consider after the test.
