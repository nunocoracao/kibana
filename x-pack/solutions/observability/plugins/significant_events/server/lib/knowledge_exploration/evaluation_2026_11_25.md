# Single-agent evaluation on Relay, 25 November 2026

The initial single-agent build used GPT-6 Luna Pro and 11 tools to assess telemetry, manage significant events, learn KIs and maintain monitoring. All live runs used the default Kibana space, its existing KIs and rules, and the same running Relay session. The three configured sources were left in place. Relay logs supplied the usable evidence. The metrics and traces probes produced no usable current measurements.

## Why healthy Relay had raised an event

The earlier supplier-air event opened in a period with 25 partial results in 1,133 search completions and zero terminal search failures. Successful outcomes continued and matched healthy windows also contained occasional partial results. A separate later outage had 947 terminal search failures against 104 successful completions. Treating every supplier warning as a search incident would confuse these populations.

The agent now checks the affected operation, denominator and a comparable baseline before promoting routine declines or partial results. A directly measured outage can be recorded immediately. Each persisted event carries the scoped source evidence the operator can inspect. Learning and rule setup use the same run and tools.

## Live tests

Carl fault injection and reversion times supplied ground truth. Separate Elasticsearch queries counted terminal outcomes, partial results and durations. The agent received its ordinary source views and tools. Detection times run from injection to the first persisted event. Recovery times below run from manual invocation of the recovery assessment. The harness waited about two minutes after reverting each fault to collect fresh outcomes.

| Scenario | Observed evidence and agent result |
| --- | --- |
| Healthy Relay, first run | Closed the previous genuine search outage 28 seconds into the run. Four complete buckets had 78, 76, 76 and 68 completions and zero terminal failures. No new incident. |
| Healthy Relay, repeat | Completed without reopening either historical incident or creating a new one. The agent saved a reusable search-outcome query. |
| Supplier-hotel at 60% errors | Opened a high-severity search partial-result event in 99 seconds, confidence 0.94, with two query signals. The event cited 47 partial results among 74 completions in the onset minute. Independently, the exact injection interval had 85 partials among 129 completions and the preceding five minutes had 11 among 352. The harness stopped the run after observing the write. |
| Supplier-hotel recovery | Marked the event inactive 25 seconds into the next run. The two post-fault buckets contained 1/56 and 0/75 partial results. Saved the recovery lesson. This version validated an unrelated terminal-failure rule and left the partial-result incident without a native rule. |
| Payments hang | Opened a high-severity booking incident in 91 seconds, confidence 0.88, with four evidence queries. During the fault there were 13 technical booking failures, one ordinary rejection and zero successful bookings. In the four-minute reference there were 46 successful bookings and one decline. Search continued serving requests. The first rule predicate failed validation. |
| Payments recovery | Marked inactive 34 seconds into the next run. Booking and payment each recorded seven successes in the newest sampled minute. The harness stopped the run after the recovery write. |
| Supplier-hotel at 12% errors | Opened a medium-severity supplier quote incident in 118 seconds, confidence 0.97, with three query signals. The onset evidence showed 12/74 failed quotes after earlier buckets with zero failures. An independent search query found 23 partials among 177 completions during the fault against 8 among 282 in the preceding five minutes. The test harness expected a search-level title and scored a miss. The event correctly identified the affected supplier and its operation. It left the search impact unlinked. |
| Lower-rate supplier recovery | Marked inactive 35 seconds into the recovery run. After the last failure the two complete buckets showed 0/74 and 0/71 failures. The run finished with zero active events. It recorded a rule setup blocker after omitting the baseline pipeline. |
| Repeated payments hang | Opened a high-severity event in 91 seconds with confidence 0.98 and two query signals. Gateway returned 17 failed bookings and zero successes. Booking reported 16 technical failures and one rejection. Before injection, 36 bookings succeeded and six ordinary rejections accounted for every gateway failure. The agent assigned a second event ID to the recurring mechanism. |
| Final recovery | Closed the recurring booking fault 53 seconds into its recovery assessment, after technical timeouts stopped and bookings and captures resumed. The run validated a broad booking-failure metric and preserved the distinction between expected rejections and technical timeouts. It left the timeout-specific native rule uninstalled. |

## Model replays

On 19 unlabelled windows of actual Relay telemetry, the agent's model classified all 13 healthy or recovered windows as quiet and all six degraded windows as active. It rated the two lower-rate partial-result windows medium and the four terminal search or booking failure windows high. Each decision received a matched reference and recent per-minute aggregates. The evaluator knew the labels. The model saw only the measurements and system prompt. These replays test the decision after collecting evidence. They do not measure autonomous query selection or tool execution. Several windows come from the same fault.

## Changes prompted by the trials

- The active-event index now reads active and recovering incidents only. Once fresh evidence identifies a candidate, a separate historical lookup accepts source and affected entity IDs. The agent compares the operation and mechanism before minting a new issue key. This addresses the observed duplicate booking event.
- A native rule can be validated by its installed ID using the saved predicate, cadence and source-local KIs. Predicate errors identify missing witness columns and explain how to extract literal dotted JSON keys. For a candidate baseline the tool requires an ES|QL pipeline and explains how to derive it from the successful source query.
- Finish checks look for coverage of the actual incident. If a different source is unavailable, that gap is recorded separately. An uncovered event prompts a rule attempt or an event-specific reason. A rule created after recovery can link to the incident's detection-learning KI without revising the closing timestamp. The agent receives the exact KI properties used to persist that relationship.

A separate two-case identity replay using the updated prompt and scoped lookup returned the original booking event ID for the payment recurrence and a new identity for search partial results versus terminal failures. The live duplicate is retained in history. The revised identity lookup still needs another live recurrence to establish how reliably the agent uses it.

## Verification and final state

All 2,481 significant-events plugin tests and 26 Agent Explorer tests passed. The plugin type check and Git whitespace check passed. The two healthy controls used the existing space with stored KIs and rules. This evaluation did not run an empty-space bootstrap. Automated installation of a precise timeout monitor remains unproven in these live trials.

All four injected fault handles were reverted. The original Relay session was left running with zero active faults. The Detection Agent was idle, all six historical events were inactive, and scheduling was off at its existing three-minute interval. The local Kibana reload interrupted an older multi-agent worker while switching implementations. One recovery request encountered a development-server reload and was retried after readiness.

## Run IDs

| Trial | Kibana run |
| --- | --- |
| healthy-first | `9914d896-7fa6-422e-a048-878fc76becf8` |
| healthy-repeat | `b0686e61-2199-4195-9dcc-a105361ee67b` |
| hotel-fault | `f964e073-a171-459d-8ff9-bb26aced5fd1` |
| recovered | `38d72dfd-a260-4e89-ad46-c0df04aa5177` |
| payments-hang | `4eeeb844-ba39-4cff-bbfe-1b6bb9eb3ba2` |
| payments-recovery | `59d0f7c3-65a5-4e88-aa8b-1792a3692693` |
| low-hotel | `5e659cb1-4a28-4419-bd85-f113880148b6` |
| low-recovery | `7a9d92c3-62bf-4fb0-b83f-815832d9b99e` |
| final-payments | `72c962af-00f9-4c9f-87d3-d0b94467ae73` |
| final-healthy | `1430093a-998e-456b-8d9b-aa9637e2f980` |

## Skills, prompt and tool reevaluation

Three read-only skills now run inside the same Detection Agent. The agent can load investigation, event lifecycle and learning/monitoring procedures alongside its ordinary tool calls. Agent Anatomy renders the same skill content that the model receives. Opening, updating and closing share one lifecycle procedure and the canonical severity and confidence criteria.

| Always supplied to the model | Before | After |
| --- | ---: | ---: |
| System prompt characters | 12,734 | 1,745 |
| Top-level tool description characters | 19,709 | 2,976 |
| Characters in serialized tool definitions, including parameter schemas | 34,134 | 16,390 |

Skill text is added on demand. These are character counts from the live anatomy endpoint. They do not measure billed tokens, total conversation length or a guaranteed reduction in cost.

The first healthy skills run finished with zero new events. An initial 49-second payment fault exposed a miss. The agent observed three technical booking failures and deferred the feasible denominator check until a future run. The finish tool now distinguishes a candidate that still needs a feasible check from one genuinely blocked by missing data. When the earlier fault drained, three 120-second charge timeouts temporarily produced a separate incident. Their inferred start timestamps all fell inside the original fault. Subsequent work had 30 captures, two ordinary declines and zero technical failures in the audited sample. The agent closed the incident in the same run. The skills and ES|QL time-window guide now teach attribution by start time or correlated request ID.

On the repeated fault, the agent reused the existing booking event ID 81 seconds after injection, attached four evidence queries, and installed and linked a native monitor for the booking payment-hop timeout predicate. It used literal dotted-key extraction and verified the predicate. The preceding run also saved a source-local detection-learning KI for processor failures and installed a separate native monitor. Independent source counts found 20 technical booking failures, three ordinary rejections and zero successful bookings during the fault, against 34 successful bookings and five ordinary rejections in the preceding three minutes. The Agent Explorer run includes the recovered rule-input errors as well as the successful native writes.

On that first recovery retest the agent kept the booking event active after the booking timeouts had cleared. It relied on downstream charge completion buckets. The revised active-event index now asks the agent to measure the original operation and check the start times of residual failures before continuing the event. The next healthy control closed the event in 32 seconds. A new payment fault then reopened the existing booking event in 97 seconds, retaining the linked native rule and adding three query signals. Nine bookings failed technically, two were ordinarily rejected and none succeeded during the injection. This latency trial stopped after the event was persisted.

The final prompt and loaded investigation and lifecycle skills made the expected quiet/active decision on 22 blinded windows, including 15 healthy or recovered ones and seven with verified impact. The first coarse one-minute delayed-completion replay suggested an active event. After adding first and last start/completion timestamps, both the one-minute and two-minute delayed windows were correctly quiet. The new-failure comparison remained active. These tests distinguish access to the right measurements from the agent's ability to select the right queries during a live run.

The final recovery assessment marked the booking event inactive 30 seconds after invocation, about 2 minutes 35 seconds after fault reversion. It observed 14/14 successful bookings in the 16:08 UTC minute and subsequent success after the earlier payment-hop timeouts. Both linked rules and the historical evidence remained available. Scheduling delay is separate from the measured manual-run latency.

Agent Explorer exposes the full procedures under **Agent Anatomy → Skills**, the shorter coordinator instructions under **System prompt**, and the actual parameter schemas under **Tools**.

| Skills trial | Kibana run |
| --- | --- |
| healthy | `18f20f2c-584a-4a85-9a26-6f8ff37f0ca7` |
| fault | `25bb1930-ad13-4eba-b13f-654af6fa6913` |
| recovery | `03fd5758-bc61-45b3-94a8-12de4e73cf6e` |
| retest-fault | `7fd9cab4-e941-459e-a722-8171c340689f` |
| retest-recovery | `aff23c09-f17f-46e8-abd9-e18999d48768` |
| closure-control | `7a0e18dc-068f-47f6-97ca-eb55c12bd59c` |
| last-fault | `b831ae17-fdb1-4dc4-862e-44c89136eb69` |
| last-recovery | `eadb7bfc-3db1-48b5-88dd-9e18a92b10be` |

The final build passed 2,485 significant-events tests and 27 Agent Explorer tests, both plugin TypeScript checks and the Git whitespace check. All three additional fault handles were reverted. The original Carl session remained running, all seven historical events were inactive, the three configured sources were preserved, and the three-minute schedule was off. These live trials assessed Relay logs. Metrics and traces did not supply current evidence for this evaluation.

## Evening tool-call audit

Five retained runs beginning between 18:08 and 18:19 UTC contained 179 tool calls and ten failures. The failures included source ownership on KI writes, an uppercase event key, partial throughput, an unspecified field profile, invalid ES|QL projections and aliases, and a read-only rule baseline rejected by the installation compiler. Replaying the two repaired baselines over their original windows returned 42 minute buckets each.

Live follow-up exposed two additional contract mismatches. The rule validator replayed numeric HTTP status codes as strings. The corrected predicate matched 12 Warren gateway failure examples, including both originally rejected 503 rows, and excluded all eight comparison rows in the same trace sample. Rule installation and the learning check also missed an existing service entity stored with `properties.service_name`. Both recognize that field on older service KIs, and new writes populate the canonical `properties.name`.

The agent closed the Warren gateway episode after successful traffic returned and installed a native monitor. A later sorted raw metrics preview requested several unmapped fields. Replaying the projection over its original three-minute window returned 20 rows in descending timestamp order using the four mapped fields. Repairs to raw previews preserve the requested time, ordering and row limit. A missing predicate or aggregation field still requires a corrected query. Another read mistyped a source UUID. The read tool now accepts exact catalog slugs and returns the canonical ID. Ambiguous or unknown selectors cannot read another source.
