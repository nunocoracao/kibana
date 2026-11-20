# Detection Agent multi-source CARL evaluation — 2026-11-20

This campaign improved native evidence, learning, source coverage feedback and failure handling. It demonstrated HTTP failure detection/recovery, a persistent correctness finding, and one backlog detection before synchronous errors. It also exposed misses, identity drift, misleading temporal/count interpretations and non-progress loops. **It does not establish reliable whole-system coverage or a detection-latency SLA.**

The work ran in `kibana-fork` on `one_agent_to_rule_them_all`, with local Kibana/Elasticsearch 9.7.0-SNAPSHOT, GPT-6 Luna Pro and real CARL Compose applications. The three existing logs/metrics/traces source definitions were never edited, replaced or reset. The original Mirage, Relay and Warren crawls were not faulted or stopped. Scheduling was already disabled and stayed disabled. Evaluation runs used explicit `evaluationMode=true`; normal manual/UI/scheduled defaults were preserved.

## Method and observed results

The agent received configured source metadata, native knowledge/rules/events and indexed telemetry. No simulator topology, fault ledger, handles or expected outcomes were supplied; naturally emitted service/namespace identities remained visible. The live prompt/tool implementation contains no dungeon-specific condition. The observer independently retained injection/reversion times, actual outcomes and native writes. Development misses and later retests are reported separately; a previously failed holdout does not become an independent holdout pass after development.

| Case | Observation | Assessment |
| --- | --- | --- |
| Initial healthy controls | Two runs created no new incident; expected declines/rejections and stale cumulative 503 values were not promoted into outages. | Limited negative controls, not estate-wide proof of health. |
| First queue pause | Early admission success concealed stalled processing. First observed queue HTTP 503 was 16:52:07.936 UTC; event appeared at 16:57:16.239. The detecting invocation began 16:55:20.911. | Early backlog miss; later HTTP failure detected with native query signals/rule. Delay includes manual invocation and development. |
| Independent Spoke failure | Fault at 17:04:29.103; native event created at 17:05:49.791 (80.688 seconds after injection, 47.185 seconds after invocation). Exact span outcomes, positive successes and prior zero-failure comparison were retained. | Detected; span counts were explicitly distinguished from logical requests. |
| Spoke recurrence | A later run created a narrower catalogue/search ID rather than reopening the initial five-service event. Later updates kept the narrowed ID as reach expanded. | Identity drift was a failure. Source/entity overlap review now requires reuse or an explicit independent-mechanism explanation; regressions cover both choices. This does not erase the earlier duplicate history. |
| Initial correctness holdout | Real credit-ledger drift produced audit mismatches while HTTP requests succeeded. Early runs skipped the audit emitters or used unvalidated generic markers. | Miss. Current emitter inventories, representative payload inspection and current-check feedback were developed afterward. |
| Correctness retest | Current positive reconciliation observations were eventually persisted as a high-confidence correctness event with a native rule/query/lesson. It remained active after revert while audits were still positive. | Detect/review behavior demonstrated after development; affected underlying store/cause remained incompletely attributed. |
| Old mismatch sample after clearance | Fresh exact audits were zero when an older representative category still illustrated a positive mismatch. | Correctly refused a new active incident from that stale comparison. CARL's bounded ledger trims records; zero later audits are not proof that historical corrupt records were repaired. |
| Final queue retest | Pause at 17:58:26.680. A backlog event was saved at approximately 18:01:32; first queue HTTP 503 was 18:01:45.347. The agent measured rising pending work and a stationary completion count across observations, before synchronous failure. | One early detection, about 13 seconds before the first 503; earlier queue passes still missed. Roughly three minutes from injection is not “as soon as it appears.” |
| Queue recovery | Fresh pending=0 observations and advancing acceptance/completion totals supported closure at approximately 18:09:44. | Positive recovery proof, rather than missing telemetry or revert success. |
| Correctness recovery | Fresh recurring zero-mismatch audits supported closure at approximately 17:59:06. | Confirms current invariant clearance within the retained dataset; no historical repair claim. |
| Post-reversion background finding | Mirage showed recurring slow-operation markers, then new typed 503 observations corroborated between logs and traces. No fault was injected into that user-owned crawl. | Unattributed live finding, not a scored injected-fault pass or a proven false alarm. The shared local host and background workload were not isolated for this candidate. |

Representative categories, temporal windows and population semantics mattered. One initial finding overstated rates using a failure-filtered denominator; another summed repeated mismatch snapshots. Guidance now distinguishes operation populations, attempts/spans, repeated state counts, current progress and historical comparisons. Some model prose still called sliding-window boundary buckets complete. Evidence preserves the executed query, fixed window, exact observed rows and collection time; prose is not a substitute for those records. Relative NOW() is frozen at collection time for the stored window; reruns can differ with query timing or late ingestion. Confidence values were not statistically calibrated by this small campaign.

## General changes and validation

- Native query signals preserve executed queries, observed rows and fixed evidence windows without fabricating detections or rule firings. The existing event flyout/chat canvas expose affected-service links, evidence verdicts and Open in Discover. Historical comparison windows are contextual evidence. Real query and native rule references are distinguished from an unbacked query's computed, uninstalled rule ID.
- Event writes require verified source-local affected entity anchors and fresh evidence for every confirming source. Existing original evidence can be recovered from an available original run when enriching a disconnected record. Cleared/truncated history cannot supply missing proof; legacy inactive records are not silently rewritten on read.
- Event transitions leave reusable native detection-learning records. Confirmed identities, payload contracts and reusable outcome queries are persisted in the normal stores and remain visible to existing Knowledge/Queries/Rules/Events views.
- Source reads first provide capped volume/latency planning; a capped count is a lower bound. Fractional probability sampling passes the inference adapter and executes after explicit scope. Sampled-only evidence cannot establish incident rates/recovery. CATEGORIZE helps learn patterns but is not a scan cap. Partial results cannot become evidence. Custom pagination now honors offset.
- Current emitter inventories expose rare/new services independently of narrow incident reads. Combined limited reads warn about omitted requested services; representative categories expose last-observation age. Explicit sample pipelines are honored as custom rather than ignored. Counter-value inspection was validated using a numeric copy with dimensions/reset/time identity retained; that conversion does not establish rates.
- Finish feedback names source title/type to prevent satisfying a log/metrics gap with a trace query. Scoped empty reads stay unknown and keep coverage partial. Repeated identical unfinished work without progress terminates explicitly partial rather than looping indefinitely. These are semantic/liveness outcomes, not restored duration/token/cost ceilings.

The existing `nightshift-evals` KI task informed window-grounded precision, observed-edge attribution and the distinction between “never sampled” and “sampled but not reported.” Its setup runner was not used against this stack because it creates/deletes sources and replays/deletes streams. This campaign does not claim that task's official scores.

Individual model requests/tool calls retain operational deadlines, cancellation and bounded retries. Evaluation invocations have null total duration/turn/token/estimated-cost budgets and can continue with missing provider usage; missing usage remains marked incomplete. Several runs required query/input repair, and two evaluation runs were cancelled to fix diagnosed loops. Run estimates therefore do not represent complete incurred charges. Normal UI/manual/scheduled budgets remain unchanged.

The repository check wrapper was invoked with local and staged scopes and `--no-fix`; shallow-history change detection skipped its affected-file lint/Jest/type checks. Direct scoped checks were run instead. See the machine-readable ledger for run IDs, exact costs/flags, native event evidence and fault/capture timelines. Browser visual verification was unavailable; UI evidence links and rendering were covered by scoped tests, with real stored queries also reexecuted against Elasticsearch.

## Remaining quality gaps

Detection speed is still inconsistent, broad metric/operation understanding and native monitoring coverage remain incomplete, and a changed diagnosis can still need explicit incident-identity review. The campaign included repeated development cases and only a narrow transfer check, not a broad unseen benchmark. It provides no universal precision/recall or calibrated-confidence claim. Snapshot counts, currentness, causal attribution and unsupported whole-system claims need continued scrutiny against actual query evidence. The agent can persist useful knowledge/rules, but artifact quantity is not coverage or success.

All owned faults were reverted. Captures preserve the actual experiments; only the three owned test crawls are cleaned up. Original user crawls, configured sources, source data, native outputs and run history remain available. The machine-readable result records the final state and capture IDs.

## Final retained state and validation

All three source definitions compare equal before/after (canonical SHA-256 `adf89fe58057042e7c5fda385c24001b6e3f41760924d758f2d3ebfb6faad1da`). Agent scheduling is off at the original five-minute setting, with no run left active. The native APIs returned 70 log-source, 14 metric-source and 17 trace-source KIs; 18 query records, including seven enabled native rules; and seven inactive event identities. Counts include pre-existing data and are not coverage scores. One older closed Relay record still has no signals; no historical record was silently rewritten or invented.

Validation: **390 backend tests in 20 suites; 79 UI tests in seven suites; scoped server/UI/shared-schema types passed.** Scoped Nightshift localization validation passed (1,802 messages); its fixer removed five stale retired-status-banner IDs from each of five locale files. Changed TypeScript lint has no errors and one tracking warning on an EntityChip wrapper that supplies its supported `ebt` prop. The repository wrapper’s shallow-checkout limitation is described above.

Across 15 recorded invocations, reported chat-token estimates sum to **$0.86269**, with incomplete usage on some runs. This excludes unreported model usage, embeddings, cache-write charges and Elasticsearch compute; it is not a complete incurred-cost total.

| Run | ID | Status | Reported chat estimate | Complete usage/pricing |
| --- | --- | --- | --- | --- |
| baseline | `0b0c4237-6258-47b8-b3b6-5b7b48d87ad0` | completed | $0.02407 | yes |
| baseline-learning | `0a52a4c4-609c-48b0-b848-f04916482c91` | completed | $0.02508 | yes |
| sluice-pause | `8397c03e-c93a-49a9-998b-581a67f95f08` | completed | $0.02513 | yes |
| sluice-sustained-before-fix | `54a22611-f9b0-4427-9b83-f5c2196caba7` | completed | $0.06105 | yes |
| sluice-active-after-quality-fix | `507c6a16-9b47-486c-beb4-9e6ca8d5f19f` | completed | $0.03179 | yes |
| spoke-transfer-sluice-recovery | `1974a1cd-e99b-4921-87e0-4441826d7127` | completed | $0.04493 | yes |
| escrow-holdout-active | `7981be4f-53e1-4992-a758-26f545df1e5a` | completed | $0.02997 | yes |
| estate-coverage-retest | `e7a012ea-5826-4257-acd7-6ae51c37891b` | completed | $0.05123 | yes |
| payload-coverage-retest | `9b819f4c-6754-46af-b6cd-ddf4b4d00583` | completed | $0.11408 | yes |
| learned-recurrence-active | `6f3e85a7-cef4-458f-9b56-a7344aba20f0` | completed | $0.09332 | yes |
| complete-current-coverage-retest | `26d9c39c-a1a4-446f-b57e-8edfa384a2fd` | completed | $0.08288 | no |
| final-queue-early-recovery | `c87810c8-ab16-4c31-bec0-260fc3b5817f` | completed | $0.05555 | yes |
| final-temporal-retest | `04f76ef9-9242-4d8a-82b7-999a4cf3ffd4` | cancelled | $0.06822 | no |
| final-recovered | `24d1d7b6-8957-4de6-bf4d-fd5aa97c2223` | cancelled | $0.07066 | no |
| final-completion-check | `17a8a699-64a7-475d-a631-1f5b1b189607` | completed | $0.08473 | no |

| Owned crawl | Recording | Captured bundle | Documents |
| --- | --- | --- | --- |
| spoke | `6dae9d6e-b6ad-4650-a9b3-16f30dbb3acd` | `14217f24-3531-42c0-bc85-8dd93a8a8615` | 1,120,813 |
| escrow | `16498676-6ab1-4a4f-94ac-387c9749928a` | `922fce4e-0ad0-4f16-a8bc-3b155633cacc` | 845,943 |
| sluice | `68b17804-39e1-48e7-8fb6-1913b8cf5cdd` | `35f550aa-a4f1-4ae7-b5ea-f6965d4dfacb` | 1,716,244 |

The three owned crawls were stopped after their captures completed. The original user crawls remain running and unfaulted. Data streams, source definitions, native outputs and run traces were retained. Raw observer/campaign files are local in `/private/tmp/one-agent-port/multisource-campaign/`; the reproducible compact ledger is [evaluation_2026_11_20_multisource.json](evaluation_2026_11_20_multisource.json). Bundle IDs are capture artifacts, not recording IDs. Replaying them faster would not recreate the original live minute-bucket baseline.
