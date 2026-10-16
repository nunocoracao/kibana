# Significant Events Plugin — Agent Context

Significant Events is the name for a set of functionalities meant to derive useful information from Nightshift sources (the ES|QL queries managed by `nightshift_sources`), related to incident monitoring, investigation and remediation.

It used to be part of the Streams plugin, now it is in its own dedicated plugin.

## Naming conventions

Never abbreviate "significant" in identifiers, file names, or folder names:

| ✅ Correct            | ❌ Avoid      |
| --------------------- | ------------- |
| `significantEvent`    | `sigEvent`    |
| `SignificantEvent`    | `SigEvent`    |
| `significant_event_*` | `sig_event_*` |
| `SIGNIFICANT_EVENT_*` | `SIG_EVENT_*` |

As Significant Events used to be co-located inside Streams, a lot of symbols were prefixed with `SignificantEvents`. Now that there is a separate plugin, consider removing it.

The guideline is: if a concept is meant to be used outside the context of the plugin, consider prefixing it with `SignificantEvents` or `significantEvents`. If it is not, it is safe to not include the prefix.

When something is related to the Knowledge Indicator (KI) system, it should be indicated as such. `KnowledgeIndicator` (or `knowledgeIndicator`), or the use of `KI` are ok. `Ki` is not.

## Cross-package ownership

KI feature extraction, query generation, KI search, token helpers, and diverse
sampling live in `@kbn/nightshift-ai`
(`x-pack/platform/packages/shared/kbn-nightshift-ai`), owned by `@elastic/nightshift`. This
plugin adapts Nightshift sources through `sourceToAnalysisTarget` before calling
into that package.

## Data model

- Knowledge indicators, detections and events are keyed by **source id** (`source.id` in storage). Source-scoped payloads carry `source_id`; events can span sources, so they carry `source_ids`. The old stream-name field is gone from storage, schemas and the wire.
- KI data, reads, onboarding, sync settings and managed workflows are **space-scoped** (reads go through `inSpace(space)`, workflows are installed per space). Maintenance is **per space**: pause, resume and status read and write one saved-object document per space (`significant-events-maintenance-state`, `namespaceType: 'single'`, same id in every space), and a space without a document is enabled. Pause leaves the shared workflows (space `*`) enabled and only disables that space's scheduled workflows, rules and settings. Reset stays deployment-wide: it pauses every space through its own document while it deletes the shared Significant Events data streams, then enables them again. Turning Nightshift off pauses every existing space the same way.
- HTTP paths are unchanged on purpose. The KI and onboarding routes stay under `/internal/streams/{name}`, where `{name}` is a source id, and `/internal/significant_events/*` stays where it is.
- Managed workflow ids keep their `system-streams-ki-*` names.
- Legacy handling that stays: the `sigevents:stream:<name>` rule ownership tag (`LEGACY_RULE_STREAM_TAG_PREFIX`) and the maintenance reset sweep.

## Agent Explorer prototype

The active KI extraction path is `server/lib/knowledge_exploration`: one space-scoped,
source-aware inference tool loop across all enabled sources, triggered on its configured minute cadence (60 by default), when
sources are added/changed, or manually. It uses no Agent Builder skills. The old
feature-identification agent, computed/inferred identification endpoints and extraction
skills are disabled. Monitoring Setup maintains native-rule query references, and V2 Event Discovery runs a separate correlation/investigation loop.
The periodic managed workflow invokes the global loop once rather than running an agent
per source. Source-added runs prioritize the new source while retaining cross-source context. Initial
learning (sources without completed novelty checkpoints) receives larger snapshotted
time/turn/token/cost limits than incremental runs. Completion means useful supported
exploration, not an exhaustive taxonomy or log sweep. There are no fixed finish nudges
or forced write rounds; partial reports real blockers or actual limits.


The loop exposes a shared on-demand ES|QL reference, source catalog, source-scoped ES|QL templates/custom pipelines,
read-only Kibana tool access, compact KI index/detail/upsert, and explicit completion.
Infrastructure inventories include ECS/OTel Kubernetes, host/IP, container and cloud metadata.
The prompt covers entity, dependency, infrastructure, technology and schema families;
operational patterns use inferred schema KIs rather than fabricated computed payloads.
Writes preserve the existing feature schema and stamp source ownership and run provenance.
Knowledge Extraction also writes non-rule-backed stats query KIs using the existing query
schema; Monitoring Setup reads and validates these reusable source-scoped measurement
recipes before adapting them into managed rules.
Evidence references are run-local handles to observed rows; dependency writes must cite
rows supporting both endpoints. Logical feature IDs are for reads/upserts; storage UUIDs
are used for deletion. A batch can save some KIs while rejecting others.

Run traces, price snapshots, model selection, novelty checkpoints and cost ledgers are
space-scoped saved objects. Changing the selected inference connector affects future runs
only; each run retains its model/connector and price snapshot. Default selection for every agent is Luna 6 Pro, with thinking requested. Explicit model selections affect future runs only. New runs require pricing and reported usage; missing usage/rates stop execution. Historical incomplete estimates remain explicit. Every run has a $50 reported-estimated cost ceiling, checked between model calls; an in-flight request can exceed it before its usage is reported. Stop cancels the model/tool signal and clears queued source runs. The Knowledge Explorer UI exposes the actual prompt/tools/settings,
per-run traces and estimates, and separate feature, history and total resets. Feature reset
never deletes generated queries or alert rules. Detection includes Overview, Timeline, Events
and Rules plus a Sources child page. It consumes current source IDs and learned relationships;
it does not import Carl's topology map. Retained KI activity filters both source ID and
`kibana.space_ids` before collecting revisions.

This branch disables the existing detection/discovery/orchestrator/review workflows while
Knowledge Explorer is evaluated. Managed YAML defaults are off; `detection_workflow_mode.ts`
blocks manual discovery and change-point execution and scheduled enablement. Startup keeps
scheduled workflows and cleanup off. Knowledge Explorer's manual/source-added/hourly paths
are independent. Do not re-enable old per-source KI extraction when adapting the Detection UI.

## Monitoring Setup prototype

`server/lib/monitoring_setup` is a tool loop with manual runs and an independent configurable minute schedule, off by default, using the shared Agent Explorer runner with separate space-scoped model selections, histories, leases, output resets and cost ledgers. Luna 6 Pro is the default for every new agent. It reads configured-source KIs, native rules and the available read-only Kibana tool catalog (including anomaly/ML context), then maintains only its exact owned native `kind: signal` rules. Query KI references keep the rules visible in Detection. Metric series collect useful baselines without requiring a severity or incident threshold; Event Discovery will judge significance. The prompt prefers a compact grouped rule set, incremental coverage and source-supported failure examples; simulator topology is never an input.

Reserved rule IDs use `nightshift-v2-monitor-` and ownership tag `nightshift:agent:v2-monitoring-setup`. Native Alerting lists these rules read-only and public routes block writes; internal managed methods retain the native rule scheduler, authorization and events. User-facing query edits/deletes/demotions are blocked for the reserved IDs. Source disable/removal and maintenance still manage them through internal lifecycle methods. Reset Monitoring removes only its native rules and query references. Detection engine activity includes Knowledge Extractor, Monitoring Setup and Event Discovery runs, polling every three seconds; skipped legacy executions do not appear as activity. Coverage reports distinguish covered, partial, blind spots and unobservable concerns and link to Detection Rules. Monitoring create/update/re-enable tools enforce at most seven active owned rules per service and namespace across configured sources; grouped rules consume a slot for every observed emitting service. Ownership tags retain those identities alongside KI references. This ceiling is not a quota: use observed critical journeys, dependency impact, user rules/SLOs and source evidence to prioritize high-impact uncovered concerns, and record concern priority/reason in the coverage report. Throughput/latency baselines do not establish failure or correctness coverage.

Agent Builder installs `v2 Knowledge Extractor`, `v2 Monitoring Setup` and `V2 Event Discovery`. All three expose no skills and use run/status/stop/anatomy control tools to launch the same instrumented loops asynchronously. Their actual prompts/tools/models live in Agent Explorer; Agent Builder launcher conversation charges are separate from loop estimates. Per-space installs happen on first explorer access/run as well as startup in the default space.

## Event Discovery prototype

`server/lib/event_discovery` correlates managed and user native rule activity and legacy Observability alerts attributable to enabled configured sources over the last 30 minutes. Manual and independent configurable scheduled invocation use the shared runner, isolated histories/models/costs/Stop and owned-output reset; hourly defaults off. Measurements are not incident verdicts. Native rule evidence is stored in `rule_signals`, separately from historical change-point `signals`, preserving actual rule/alert references. Assessments use owned native alerts, active for relevant current problems and inactive for evaluated benign/recovered/unsupported candidates. Stable issue keys and prior event IDs support continuation; operator dismissals are retained. Context KIs are not automatically causal features. Active writes require current bounded source evidence or a recent active alert; old error examples do not prove continued failure. Source samples expose first/last-seen times and label representative text honestly.

Monitoring's `monitoring_rules action=baseline` describes bounded candidate histories before setup, including sample counts, variation and gaps without inferring thresholds or filling missing observations with zero. Both Monitoring and Discovery may inspect existing series through optional `rule_change_points`; latest per-bucket revisions and complete buckets are used. Elasticsearch can return indeterminable for short/gapped history. Neither change-point significance nor constant background errors alone establish an incident. Live Carl evaluations keep simulator topology/fault ledgers outside agent context, clear telemetry/KIs/rules/alerts between systems, and run Knowledge then Monitoring before injecting faults. Start with the simplest dungeon and verify clean baseline, real fault, identity and recovery before increasing complexity.

## Keeping this file current

Update this file when you make a change that would mislead an agent reading it: cross-package ownership changes, pipeline restructuring, addition or removal of concepts relevant to the pipeline, or naming convention updates. Do not update it for type field additions or directory reorganisations within a package — those are discoverable from the code.

Agent Explorer schedule settings persist intervalMinutes separately for each agent and space (whole minutes, 1–10080; default 60). Managed workflow templates render the actual schedule and retain their values across reinstall/restart. Knowledge source-change reconciliation reads the saved cadence. Saving minutes while off does not enable execution. Legacy hourly workflow IDs/state flags remain for compatibility; frequency is no longer fixed to one hour.

All three agents must supply source_esql lookbackMinutes explicitly; there is no time-range default. The volume template bypasses schema/pattern scans and returns a capped source-wide count, rate relation and latency. endOffsetMinutes selects older intervals consistently across templates/caches; novelty comparisons are window-scoped. Agents choose narrow, wider or distributed historical samples from observed volume and latency, especially for remote clusters. Capped rates are lower bounds and sampled/quiet intervals do not establish source-wide completeness.

Agent sampling guidance is composed once into all three system prompts via sampling_strategy.ts and is visible in anatomy. A bounded record of recent source reads (scope, windows, duration, caps/errors) is retained per agent/space for the next run and cleared with output/history resets. source_esql profile checks scoped non-null field populations before value samples. Infrastructure now applies service/namespace filters before grouping; source filters coalesce mapped ECS/OTel aliases and log samples coalesce message/body.text so mixed sources do not silently hide OTel rows. Monitoring baseline is read-only and needs no KI anchors; validate/upsert still require existing source-local KI references.

Native monitor ownership may come from actual service/namespace dimensions in the validated query response, even before a service-entity KI is saved; rule references must still be existing KIs in the exact configured source. Ownership tags retain those observed identities for capacity accounting and re-enabling, preserving the seven-rule ceiling. Monitoring coverage accepts a structured array (preferred) plus legacy coverageJson; each cell carries explicit priority and priorityReason. Multiword KI index searches match any keyword rather than an exact whole phrase.


All three agent loops receive a deterministic, agent-specific sampling agenda built from enabled source types and that agent's bounded sampling history. Knowledge rotates dependency, span and populated-instrument checks across under-sampled sources and five time strata; Monitoring rotates distinct outcome/latency/resource questions; Event Discovery remains driven by current rule signals and uses historical windows only for explicit comparisons. The agenda guides acquisition and never blocks semantic KI writes or source-backed findings. Each loop tracks individual run duration and an average over its retained duration sample count; resetting totals or run history resets the duration aggregate.
