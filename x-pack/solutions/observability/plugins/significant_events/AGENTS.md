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
- KI data, reads, onboarding, sync settings and managed workflows are **space-scoped** (reads go through `inSpace(space)`, workflows are installed per space). Maintenance is **per space**: pause, resume, reset and status read and write one saved-object document per space (`significant-events-maintenance-state`, `namespaceType: 'single'`, same id in every space), and a space without a document is enabled. Pause leaves the shared workflows (space `*`) enabled and only disables that space's scheduled workflows, rules and settings. Reset clears only documents tagged with the current space, preserving shared data streams, sources/views, investigations, untagged legacy documents and `.rule-events` history. Turning Nightshift off pauses every existing space.
- HTTP paths are unchanged on purpose. The KI and onboarding routes stay under `/internal/streams/{name}`, where `{name}` is a source id, and `/internal/significant_events/*` stays where it is.
- Managed workflow ids keep their `system-streams-ki-*` names.
- Legacy handling that stays: the `sigevents:stream:<name>` rule ownership tag (`LEGACY_RULE_STREAM_TAG_PREFIX`) and the maintenance reset sweep.
- An event with a recorded investigation takes its severity from that investigation's outcome, and the stored severity is a copy kept in step by `severity/` (`createSeveritySync` on the server object): the investigation agent hook writes it right after the findings recorder's final pass, and Discovery's write keeps it. Reads never write: the events list, detail and attachment card return the stored severity, and only `event_search` shows the investigation's. A sync writes a version with its own assessment note and no workflow execution, and never writes a closed event, whose close time and closing note Discovery's reuse reads. An investigation governs an event only through the event's current episode (the `alert.id` of its latest version): a reopened event is a new episode, rated from its own evidence, and an earlier episode's investigation governs nothing, so Discovery's write does not resolve a closed event's severity and `syncSeverity` refuses a head on another episode. `resolveInvestigationOutcomes` is the only place that decides which investigation governs an event.

## Pull request descriptions

Follow the [`nightshift-pr-description` skill](../../../../../.agents/skills/nightshift-pr-description/SKILL.md) when writing or rewriting a pull request description.

## Keeping this file current

Update this file when you make a change that would mislead an agent reading it: cross-package ownership changes, pipeline restructuring, addition or removal of concepts relevant to the pipeline, or naming convention updates. Do not update it for type field additions or directory reorganisations within a package — those are discoverable from the code.

## Unified problem-agent branch

On `one_agent_to_rule_them_all`, `server.problemAgent` owns detection: one model loop with exploration, native monitoring and event tools. No separate KI extraction phase or native rule firing is required to find a problem; writes attach real query signals and verified source-local affected-service KI anchors. Source changes reconcile catalog ownership but do not run onboarding. Legacy detection workflows are retired and their execution routes return a conflict; investigation workflows remain independent. The Agent Explorer and `/internal/significant_events/problem_agent` control manual runs, cancellation, model, run history, resets and the credentialed Task Manager schedule. Every existing active problem must be rechecked before a run claims completion. Recurrence reuses an event only within four hours of its last inactive assessment; after that the event tool creates a new occurrence under the same logical issue key and preserves the old event. A validated event ID is authoritative over a redundant differing issue key. The default connector is GPT-6 Luna Pro; explicit model selections still take precedence.

Detection lessons are native schema/custom KIs with `properties.kind=detection_learning`; enabled-source, non-excluded/non-expired lessons are loaded into each run. Bounded execution feedback stays in the existing per-space agent state. Explicit remaining knowledge gaps survive successful current-health coverage. Run-history resets clear execution feedback, while owned-output resets also remove learned KIs.

Run effort adapts to persisted source understanding and known-service monitoring gaps instead of total run count: learning focus has the larger initial-learning limits; established operation focus uses incremental limits. New services/sources can return effort to learning. Artifact presence is a minimum inventory signal, never proof of complete coverage or a rule quota.


Explicit manual evaluation runs may set `evaluationMode=true` on `POST /_run`; only that invocation receives null duration/turn/token/cost budgets and may continue with unreported provider usage. Normal UI/manual/scheduled limits remain unchanged, missing usage remains marked incomplete, and per-request deadlines/cancellation remain available.

The unified source reader requires volume planning, supports fractional exploratory sampling, rejects partial query evidence, and exposes a bounded current emitter inventory even for narrow reads. Finish feedback distinguishes observed service identities, unfamiliar payload contracts and actual current checks. Quiet scoped empty results remain unknown; they permit honest partial completion without clearing an event or claiming full coverage. Reusable event-transition lessons persist in the native KI store. Repeated identical unfinished work ends explicitly partial rather than looping without progress. Feedback names source type/title; historical comparison signals remain contextual. The agent decides whether evidence supports opening or closing an event and whether overlapping services represent distinct problems. Failure and success counts are optional evidence annotations. See the multi-source November 20 evaluation report for observed misses and remaining coverage limits.
