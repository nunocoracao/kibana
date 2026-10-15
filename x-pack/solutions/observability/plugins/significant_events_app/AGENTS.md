# Significant Events app — agent notes

- This plugin hosts the Significant Events UI, extracted from `streams_app`. The
  server side lives in `x-pack/solutions/observability/plugins/significant_events`; follow
  the naming conventions documented in that plugin's `AGENTS.md`.
- Never abbreviate "significant" to "sig" in identifiers, filenames, folders, i18n
  ids or test subjects. `significantEvent` / `significant_event` only.
- i18n messages use the `xpack.significantEventsApp.` prefix.
- Data access goes through `significantEventsRepositoryClient`
  (`dependencies.start.significantEvents`). Sources (the ES|QL queries Nightshift
  onboards) come from the `nightshiftSources` plugin: `await
  dependencies.start.nightshiftSources.getClient()`, then `fetch` on
  `/internal/nightshift/sources*`. Read them through `useFetchSources` /
  `useSourcesById`, write them through `useSourcesApi`.
- The app does not depend on the `streams` plugin. The KI and onboarding routes keep
  their `/internal/streams/{sourceId}` paths, and `{sourceId}` is a source id.
- The default tab is `sources` (`/streams` redirects there). URL state and the locator
  filter knowledge indicators with `source` (source ids).

- The prototype Detection workspace has Overview → Timeline → Events → Rules. Its Sources
  link opens `/detection/sources`; creating/selecting a source uses the current source flyout.
  Evidence links store `source` IDs in the URL. Source IDs are opaque: namespaces and service
  membership come from KI properties/references, never from parsing an ID. The Next steps
  toggle defaults to Events and hides Overview, Timeline, deployment/preset filters and coverage.
- Detection read views remain usable with workflows off. The server's prototype workflow
  guard disables discovery/detection execution; Knowledge Explorer remains the KI agent.

- Agent Explorer retains `/knowledge-exploration` for existing links and has separate Knowledge Extractor, Monitoring Setup and Event Discovery tabs with independent schedule toggles and saved minute frequencies (60 by default; Monitoring and Discovery default off). Each action targets its own endpoints and cache keys; never let Monitoring controls call Knowledge endpoints. Coverage reports link to Detection Rules. Agent Builder control entries launch these same instrumented loops. Discovery controls target its own endpoints and persist native active/inactive assessments, both visible in Detection Events.

The shared Agent Explorer header has two control rows: badges/model selector/Agent anatomy/Agent Builder, then schedule toggle/minutes/save/output reset and Run/Stop. Summary statistics show total cost and average cost per run, not a selected-run cost or token counter. Each tab saves its own frequency without enabling a disabled schedule.
