# Knowledge Explorer prototype

One tool-based inference loop explores all enabled Nightshift detection sources in a
Kibana space. It is invoked manually, when a source is added/changed, and once an hour
when the hourly setting is enabled. There are no extraction skills or per-source agents.
The old feature-identification paths are disabled. Existing detection, discovery and review
workflows are disabled on this prototype branch while Knowledge Explorer is evaluated;
query generation remains a separate existing path.

## Knowledge and evidence

The system prompt explicitly covers the five existing inferred KI families:

| Family | Examples |
| --- | --- |
| Entity | Services, workers, jobs, databases, caches, brokers, external components |
| Dependency | Directed calls, datastore connections, messaging and external integrations |
| Infrastructure | Kubernetes clusters/namespaces/nodes/workloads/pods, hosts/IPs, containers/images, cloud placement |
| Technology | Runtimes/languages, frameworks/libraries, database/broker engines, protocols, versions |
| Schema | ECS/OTel/custom field contracts, log formats, correlation fields and recurring operational/error patterns |

Computed KI payload contracts are preserved, but the agent does not fabricate computed
`dataset_analysis`, `log_samples`, `log_patterns`, `error_logs` or `code_analysis` payloads.
Useful observed context is learned through the inferred schema/technology/etc types.

The explorer starts with at least 24 hours of compact service/category discovery (the ES|QL tool defaults to 1440 minutes), then scopes by service for deeper investigation. The prompt includes the canonical KI write fields and subtype conventions, plus schema inspection, categorization, structured JSON/flattened extraction and plaintext parsing strategies. Missing relationships are investigated even when novelty is unchanged; absence in a short recent window does not establish absence in the system.

Tools provide compact inventories, schema-aware ES|QL templates, bounded custom pipelines,
read-only Kibana context, and paged KI index/detail/upsert. Relationship exploration supports
service/namespace filters and paging; empty optional filters are accepted. Kibana tool execution
accepts bounded parametersJson for dynamic tool input on fixed-schema providers, validates it
against the actual selected tool schema, and returns actionable schema details for invalid input. Custom queries must alias aggregates; an exact server
verification error for SORT COUNT can retry once using the server's suggested COUNT() or
COUNT(*) column, with a warning and the actual corrected query retained in the trace. Infrastructure inventory includes
service identity so placement can be attributed. Schema pages and log rows expose run-local
evidence references. Writes copy relevant exact source evidence and preserve the existing
schema, source ownership and extraction run provenance. Reads/upserts use logical KI IDs;
deletes use storage UUIDs. Same service/dependency identities reuse existing KIs.

The KI upsert tool validates the feature schema and protects ID/type identity, but it does not
second-guess the agent's evidence or reject a dependency because a deterministic parser failed to
recognize its shape. Evidence references that are valid for the selected source are attached as
provenance; unknown references are omitted from provenance without blocking the KI write. The
agent owns the inference and confidence judgment, while the tool persists its schema-valid result.

## Completion and cost

`finish_exploration` must provide `coverageComplete` and `remainingGaps`. Useful writes do
not imply complete exploration. Concrete remaining gaps are carried into the next invocation
so it resumes unfinished work instead of replaying the service inventory. Unfinished runs retain their KIs but do not advance complete
novelty checkpoints. The prompt reviews every taxonomy dimension and distinguishes already
covered, learned, unavailable and unexplored knowledge. Completion describes a useful,
evidence-backed exploration rather than an exhaustive taxonomy/page sweep. Optional enrichment
and unavailable metadata do not force partial completion. There are no fixed finish nudges or
forced write rounds. A run without completed novelty checkpoints gets initial-learning limits
(20 minutes, 96 turns, 1.28 million cumulative tokens, $50 estimated); incremental limits remain
10 minutes, 48 turns, 640,000 cumulative tokens and $50. Limits are snapshotted per run and
exposed in the anatomy inspector. They are ceilings, not spending targets.

Novelty fingerprints use stable service/schema/pattern/infrastructure inventories, not
volume changes. A complete unchanged run exits without replaying extraction. The contract
version in the fingerprint invalidates old completion assumptions once after upgrades.

Model selection is space-scoped and affects future runs only. Each run retains its actual
connector/model and price snapshot. Defaults use the GPT-6 Luna connector, with reasoning
requested at low effort; with no selection and no Luna 6 connector configured, a run fails
with a 409 instead of falling back to another model. The UI lists available connectors;
Haiku 5.5 is unavailable in the current local deployment: creating its EIS endpoint returned
provider HTTP 403. The unavailable option is explicit rather than pretending it works.

Costs estimate reported chat tokens using the Elastic inference price catalog, with public
Haiku rates as a fallback. Missing prices, unsupported tiers and interrupted model usage
are marked incomplete. Estimates exclude cache-write, embedding and Elasticsearch compute
costs and are not the Elastic bill. Thinking token counts are shown only when reported.

Limits: 48 model turns, 640,000 cumulative reported tokens, $50 estimated chat cost,
10 minutes per run and 120 seconds per model request. Local cancellation resolves even
if a provider request stalls; saved KIs survive cancellation/interruption. Durable leases
and recovery prevent stale workers from permanently keeping the space running.

## Inspector and reset controls

Nightshift home links to Detection Overview. Its service map consumes current KI source IDs
and learned dependency endpoints, with namespace islands, service filtering and selection.
Knowledge Explorer exposes the actual prompt, tool schemas, model, thinking and limits
through Agent anatomy, plus per-run traces and costs.

Separate controls delete a run, clear run history, reset totals, and reset feature knowledge.
History/totals reset preserves KIs and checkpoints. Feature reset preserves sources,
queries/rules, run history and cost totals and clears novelty checkpoints. Operations are
space-scoped and use explicit confirmations for bulk resets.

## Live evaluation notes (2026-10-13)

These are on-the-fly checks, not a broad accuracy benchmark. Carl was not changed and its
map was not supplied to the agent. Synthetic infrastructure fixtures were clearly labelled
and isolated in a separate space. Scheduled exploration was disabled in evaluation spaces
after setup so they do not continue spending unattended.

- A fresh Luna fixture run completed in 32.5 seconds, reporting $0.004513 estimated model
  cost and zero failed tool calls. It retained 18 KIs: 2 services, 13 infrastructure records,
  1 directly evidenced HTTP dependency and 2 schemas/patterns (19 writes included an update).
- An unchanged fixture repeat completed in 14 seconds, wrote no KIs and estimated $0.032961
  on Haiku. Prices/models/cache hits differ, so these are not an apples-to-apples model comparison.
- Live Carl Relay was queried through a configured source. A Luna run saved 13 emitting
  services, 3 HTTP dependency pairs and 2 host/container records at $0.008055 estimated model
  cost. Its summary acknowledged unfinished schema/infrastructure/Kibana exploration;
  that exposed and motivated the explicit completion contract above. Do not interpret this
  run as proof of complete topology or KI coverage.
- An earlier live run stalled after 21 writes. Recovery preserved the records. Its loose
  substring dependency check admitted two unsupported edges; the cited endpoint validation
  now rejects metadata-key inference and self-links. The isolated records were cleared before
  the later evaluation.
- Cancellation was observed completing in 120 ms in an isolated run. Switching future model
  selection while Luna was active left the active run on Luna. Individual deletion, history
  reset and total reset were checked; totals/history reset retained 18 feature KIs. Feature
  reset was verified against the actual stored count, including 37 -> 0 after correcting UUID-based deletion.
- Scoped server/app/Nightshift type checks and changed-file lint passed. Browser interaction
  was not independently automated in this session; the available browser runtime had no browser.

The explicit completion-contract eval correctly finished as partial with concrete gaps and
saved useful facts. A subsequent final-prompt run checked all supported dimensions, kept
unavailable/unrelated context separate, and finished `nothing_new` with
`coverageComplete=true`, no remaining gaps and no writes ($0.004303 estimated on Luna).
This checks the completion contract, not universal completeness of arbitrary telemetry.

## Source write recovery

Agent-run leases and source-storage write leases are separate. A stopped dev worker can
leave the latter blocking deletion for its grace period even after run history is cleared.
The guarded `_recover_source_write` operator endpoint requires manage/configure privileges,
a literal confirmation, no active exploration, an unchanged source lease older than its
heartbeat interval plus a margin, and no active KI/Kibana storage write tasks. It updates
through Kibana's internal saved-object repository with optimistic concurrency; it does not
modify KIs, queries or rules. Recent/live writes remain protected. Bulk-delete errors now
retain the underlying server reason, and skipped operations do not trigger rule reconciliation.

On Oct 14, this recovered a confirmed orphaned default-source lease. A no-op source deletion
then succeeded with all 35 user KIs preserved. The same cross-source bulk endpoint was also
verified deleting a synthetic fixture KI on port 5601 and reporting it skipped on repeat.

## 2026-10-14 evidence-led exploration eval

The prompt now prioritizes useful accurate exploration over exhaustive taxonomy/schema
coverage. Fixed continuation nudges and forced early entity writes are removed. Partial is
reserved for essential unresolved questions, genuine source failures or actual resource limits.
Initial learning gets the larger snapshotted limits described above; model selection is unchanged.

A fresh isolated Relay evaluation on Luna (`098245c0-8092-4e35-a78a-c91ae0a83105`)
finished as learned with 17 accepted writes: 13 observed services, gateway→search,
gateway→booking, search→supplier-air and a supplier-rail recurring log pattern.
Estimated chat cost was $0.007321, with zero failed tool calls. Infrastructure metadata was
inspected but not persisted because the model considered sample attribution inconsistent.
This is a live smoke evaluation, not proof that every dependency or infrastructure fact was learned.
An earlier eval exposed empty optional filters and fixed-schema Kibana argument restrictions;
both were corrected. The exact COUNT repair callback was exercised against local Elasticsearch
for COUNT() and COUNT(*), and service-scoped Relay/gateway relationship queries succeeded.

For manual model comparisons, hold the source data fixed, reset feature KIs for each fresh
model trial, then repeat without resetting to measure novelty exit behavior. Compare supported
facts by family, false claims, duplicates, errors, elapsed time and estimated cost; KI count alone
is not a quality score. The default source/model/KIs were not reset by these isolated evals.

## Pricing identity and historical estimate recovery

Elastic catalog display names and inference connector IDs can order Claude family/version
names differently (for example `anthropic-claude-opus-5.5` versus
`anthropic-claude-5.5-opus`). Pricing resolution canonicalizes the exact model identity and
also checks the reported/display model name; it never substitutes another version's prices.
An existing run with no resolved price can be repaired through the manage/configure route
`POST /internal/significant_events/knowledge_exploration/runs/{runId}/_recover_cost`.
It uses the actual token ledger per model request and current verified catalog rates, records
pricingRecoveredAt, and checks accounted usage against reported run totals. Existing price
snapshots are preserved. An idempotent state marker and saved-object version checks prevent
double-counting total-cost deltas; totals resets record their boundary so older recovered
runs do not reappear in reset totals. Recovery never invokes inference or changes KIs.

The completed user Opus 5.5 run `b9172f29-8428-4127-b682-a85f85b984a5` was
recovered to $0.2896088 from 76,169 input tokens (49,436 cached) and 4,085 output tokens.
Verified Elastic rates were $6 input/$28 output/$0.30 cached input per million tokens.
Its five request costs and the space total were updated. Repeating recovery left totals
unchanged. Estimates retain the documented cache-write/embedding/compute exclusions.

## Manual-run comparison and Relay evidence improvements (2026-10-14)

Four user runs (Haiku 4.5, Opus 5.5 and two Luna runs) each retained three dependency
pairs. Relay was running in Compose with logs only and no active faults. Its configuration
was used only for offline comparison, never supplied to the agent.

Named numeric `hops` timings support inferred caller-to-component dependencies; arbitrary
metadata keys and shared correlation IDs still do not. Fluent per-log tags corroborated by
the dataset resolve conflicting resource service names. Sparse infrastructure rows remain
visible, and targeted `samples` are part of the existing ES|QL tool rather than a new tool.
Compact JSON upserts avoid fixed-schema empty-property overhead; equivalent semantic
properties return unchanged without embedding/writing again. Novelty uses a cached per-run
inventory and a bounded ledger of previously seen normalized categories, so missing sampled
categories do not count as new facts.

A fresh isolated Luna run retained 36 KIs: 13 services, 8 supported application dependency
pairs, 13 containers and 2 schemas, at $0.012768 estimated chat cost. Its missing-array tool
failure was corrected and the JSON writer now supplies harmless empty arrays. Eight of
Relay's fourteen application edges were evidenced; absence of the other edges is not proof
that those connections do not exist. A later incremental run wrote one newly observed
PostgreSQL checkpoint pattern for $0.004763; it did not rewrite the service/resource facts.
This is a live evaluation, not a fixed-dataset unchanged-run benchmark.

Detection UI was ported from `nuno/ui-experiments` using Marco's source IDs/APIs and current
alert-event statuses, keeping Knowledge Explorer intact. Legacy discovery quota/event-writing
behavior was not imported. At Nuno's request, existing detection workflows were subsequently
disabled in managed definitions and guarded against manual/scheduled re-enablement. The two
active local detection/discovery executions were cancelled; stored KIs and event history remain.
