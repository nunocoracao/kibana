# Unified Nightshift Problem Agent

This branch replaces the staged detection workflow with one autonomous tool loop. It ports the exploration, monitoring and event capabilities from `nuno/ki-extraction-agent-improvements` into one shared run, evidence session, prompt, lease, history and cost ledger. `problem_prompt.text` is the only system prompt. Knowledge indicators and monitoring rules are optional tools; direct current telemetry can establish a significant event without either.

## Run and control

Open **Nightshift → Detections → Agent Explorer** (`/app/nightshift/detections/agent`; local dev adds `/dev`). Add an enabled source first, then choose a model and Run now. Adding or changing a source does not launch an extraction workflow. Source edits cancel the current run and reconcile catalog ownership.

The panel provides Run/Stop, model selection, schedule toggle, frequency in minutes, run traces, tool input/output inspection, prompt/tool anatomy, cumulative cost and duration, history, and confirmed resets. Scheduling is off by default. It uses a persistent Task Manager task with the scheduling user's credentials and a per-space run lease; it survives Kibana restarts and does not overlap a manual run. Global pause blocks new runs and cancels the current local run. Native monitoring rules execute independently of the agent schedule.

The management API is `/internal/significant_events/problem_agent`: GET status, GET `/anatomy`, POST `/_run`, POST `/_cancel`, GET `/runs/{runId}`, PUT `/model` and PUT `/settings` (`enabled`, optional `intervalMinutes`, 1–10080). Manage/configure privileges, supported-space checks and feature/license access apply. The local mock SAML role picker remains the login flow; the prototype adds no user/password setup.

## Evidence and ownership

Every invocation reviews existing active problems and checks new current outcomes across enabled configured sources. Queries use explicit bounded windows, observed ECS/OTel fields, source and namespace scope, and run-local evidence references. Event writes require fresh evidence for every confirming source, within three minutes and without a historical end offset. A run cannot complete an assessment while leaving its initial active problems unchecked; it must report partial with the outstanding IDs.

Stable `nightshift-problem-<issueKey>` IDs preserve continuation, recovery and recurrence. The native event client provides optimistic updates and episode behavior; operator dismissals are honored. Native events have no fabricated detection signals. Their assessment notes identify the run containing actual queries and result rows. Recovery requires positive healthy operation outcomes or clearance of every confirming mechanism. Missing telemetry, empty fired-rule lists and a successful fault revert are not recovery evidence.

Knowledge writes preserve logical KI identity and source provenance. New agent-owned features carry `meta.problem_agent_owner`; standalone query KIs carry an ownership evidence marker. Existing user KIs retain ownership when enriched. Monitoring uses native signal rules with `nightshift:agent:problem-agent` ownership and stable intent IDs. Actual query validation, positive witnesses/non-null instruments, service AND namespace boundaries, equivalent-query reuse, and the seven-active-rule cap per emitting service/namespace across sources remain in place. User rules are context, never mutable through these tools.

Reset outputs stops the run and removes this agent's knowledge, native monitors and problem-event versions in the current space. It preserves configured sources, user-owned knowledge/rules, run traces and cost totals. Reset history removes traces and displayed totals while preserving outputs; reset totals only clears displayed accounting. Bulk operations require explicit literal confirmations. Incurred provider charges cannot be reset.

Legacy detection workflows are retired through their managed owner reconciliation. Source onboarding, continuous extraction, query generation and discovery execution routes reject legacy starts; read contracts remain for compatibility. Investigation workflows are independent. The existing event/rule/knowledge views read native records.

## Limits and accounting

The default connector is GPT-6 Luna Pro; any available priced connector can be selected. Each run snapshots actual connector/model, limits and Elastic catalog prices. First run: 20 minutes/96 turns/5.12M cumulative reported tokens. Later runs: 10 minutes/48 turns/2.56M cumulative tokens. Both have a $50 estimated chat ceiling, not a spending target. Model requests have a 180-second deadline, bounded retries and cancellation. Missing/unpriceable usage stops cost-protected work and is marked incomplete; abandoned requests can still be billed. Estimates exclude embeddings, cache-write costs and Elasticsearch compute.

Run state and traces use space-scoped saved objects, CAS writes, leases and heartbeats. Interrupted runs retain prior writes and concrete unfinished work. Initial learning is based on run count, not a mandatory knowledge phase. The older internal exploration names are retained to reuse the proven storage, sampling and trace components; there is one instantiated problem-agent service.

## Verification

See `evaluation_2026_11_20.md` for the recorded CARL fault/recovery/recurrence campaign, initial failures, improvements, run IDs, costs and limits. Unit regressions cover source scoping/windowing, metric dimensions, KI evidence helpers, native monitoring persistence/rollback, ownership/capacity, direct event creation, fresh recovery evidence, stable reopen identity, operator dismissal, UI Run/Stop and disabled-source behavior, scheduling controls and workflow retirement.
