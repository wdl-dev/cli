# Workflows — Long-Running Instances

## What it is

WDL supports workflow classes defined in the current Worker. This is not full
Cloudflare Workflows parity; cross-worker workflows, cross-worker callbacks,
service-binding callbacks, `script_name`, and the Cloudflare source-AST
visualizer are not supported. Same-worker DO progress callbacks and
runtime-observed parallel/DAG `step.do` execution are available.

Workflows depend on the WDL control/runtime services and cannot be fully
verified locally with `wrangler dev` alone. After deploying to WDL, use
`wdl workflows` and logs to confirm instance state.

## Wrangler configuration

```toml
[[workflows]]
name = "orders"
binding = "ORDERS"
class_name = "OrderWorkflow"
```

Worker code follows the Cloudflare Workflows mental model: `WorkflowEntrypoint`,
`env.<BINDING>.create()`, `createBatch()`, `get()`, `status()`, `pause()`,
`resume()`, `restart()`, `terminate()`, `sendEvent()`, `step.do()`,
`step.sleep()`, `step.sleepUntil()`, `step.waitForEvent()`, retries,
`NonRetryableError`, same-worker DO progress callbacks, and runtime-observed
parallel/DAG steps.

If a `step.do` fails permanently, the workflow run enters terminal failure, even
if user code catches the thrown error.

## Programming limits

- `createBatch()` accepts at most 100 entries per call.
- A single workflow result is capped at 1 MiB, and one runtime-to-Workflows
  backend JSON request is capped at 2 MiB.
- Per-instance aggregate payload is capped at 16 MiB. Step/event writes over the
  cap fail the request; when the runtime writes an over-cap terminal result, it
  transitions the instance to failed in the same transaction.
- Newly created completed, failed, and terminated instances are retained for 8
  hours by default. Override success and error retention with
  `create({ retention: { successRetention, errorRetention } })` when needed.
- One step may record at most 1000 dependency edges. A single runtime dispatch
  turn may have at most 1000 in-flight workflow steps and start at most 1000
  fresh backend steps.
- Once `step.do` promises are started, every started step must be awaited; a run
  that returns while started steps are still unsettled fails as
  `workflow_invalid_step`.
- Parallel `step.do` siblings must be created in one synchronous fan-out batch,
  then awaited together. Once you await one sibling, the whole batch must finish
  before starting the next batch of durable steps, so replay computes the same
  dependency frontier.
- `step.sleep()`, `step.sleepUntil()`, and `step.waitForEvent()` suspend the
  whole run and must not overlap another in-flight step. Do not `Promise.race()`
  to handle only the fastest step and then go straight into sleep/wait; settle
  or cancel the application-side concurrency first, then let the workflow
  suspend.

## CLI

```bash
wdl workflows list
wdl workflows instances <worker> <workflowName> [--limit <n>] [--cursor <c>]
wdl workflows status <worker> <workflowName> <instanceId> --include-steps [--step-limit <n>]
wdl workflows pause <worker> <workflowName> <instanceId>
wdl workflows resume <worker> <workflowName> <instanceId>
wdl workflows restart <worker> <workflowName> <instanceId> --yes
wdl workflows terminate <worker> <workflowName> <instanceId> --yes
```

`restart` and `terminate` are destructive instance lifecycle operations; pass
`--yes` only after independently confirming the namespace, worker, workflow, and
instance id.

`wdl workflows list` marks definitions absent from the active Worker version as
`retired=yes`. Existing instances remain inspectable and may be terminated, but
restart returns `workflow_not_exported` until an active version exports that
workflow name again.

Semantic size limits in the Workflows API return `request_too_large`; size
limits hit during HTTP body parsing may return `request_body_too_large`. A
Workflows 5xx means a platform or backend failure, and the response body stays a
generic error summary; underlying diagnostics go to platform logs and are not
stable CLI output.
`workflow_metadata_contention` means the active workflow metadata changed while
control was reading it; retry the command.

## End-to-end example

`../examples/workflows-demo` — start a workflow from an HTTP route, query its
status, and send an approval event to a waiting instance.
