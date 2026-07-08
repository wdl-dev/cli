# inspection-demo

Combined WDL example for a small inspection workflow.

- R2 stores uploaded images through `env.IMAGES`.
- D1 stores inspection rows and comments through `env.DB`.
- KV stores visit and submission counters through `env.COUNTERS`.
- Assets serves the browser JavaScript and CSS through `env.ASSETS`.

Uploads store objects under `inspections/<uuid>/<safe-file-name>` so files with
the same original name become separate R2 objects. R2 still follows normal
key-value semantics: writing the exact same key would overwrite the object.

## Deploy

From this repository:

```bash
export WDL_NS=<namespace>
export ADMIN_TOKEN=<tenant-token>
export CONTROL_URL=https://api.wdl.dev

wdl d1 create inspection-main
wdl deploy examples/inspection-demo
```

The Worker uses `compatibility_date = "2026-06-17"` and expects Wrangler v4 in
this example directory. If dependencies are missing, run:

```bash
cd examples/inspection-demo
npm install
cd ../..
```

Then deploy again.

## Open

Default runtime URL:

```text
https://<namespace>.wdl.sh/inspection-demo/
```

Upload an image plus a comment. The object key is written under the virtual R2
bucket `inspection-images`, and the metadata row is written to D1.

## Data Notes

Deleting the Worker does not delete R2 objects. Inspect or remove uploaded
objects explicitly:

```bash
wdl r2 buckets list
wdl r2 objects list inspection-images --prefix inspections/
wdl r2 objects head inspection-images <key>
wdl r2 objects delete inspection-images <key> --yes
```

The D1 database is named `inspection-main`; delete it only when the demo data is
no longer needed:

```bash
wdl d1 delete inspection-main
```
