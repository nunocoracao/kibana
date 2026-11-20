# Live unified-agent evaluation — 2026-11-20

Ran in `/Users/nuno/source/kibana-fork`, branch `one_agent_to_rule_them_all`, against local Kibana/Elasticsearch 9.7.0-SNAPSHOT and CARL Compose workloads. The setup initially had no configured sources or knowledge. The port comes from `nuno/ki-extraction-agent-improvements@9111b1a089da`. Model: OpenAI GPT-6 Luna Pro, with low reasoning effort.

## Result and limits

The final prompt detected a real pricing failure, closed it using positive operation outcomes, reopened the same native event identity on recurrence, and closed it again after recovery. A separate Sluice queue-consumer fault was withheld from prompt development: the agent detected the resulting delivery 503 failures and later closed them with accepted submissions, completed jobs and zero pending work. It did **not** demonstrate early backlog detection before synchronous requests began failing. Two actual scheduled runs over healthy traffic created no events, including for Sluice's expected duplicate/validation rejections.

This is a smoke campaign over two fault mechanisms and one recurrence, not a precision/recall benchmark or evidence of universal coverage. All final runs explicitly reported incomplete source coverage. Some model queries still needed repair; one recovery write exceeded the assessment-note limit, then succeeded on retry. Numerical summaries can drift from the underlying aggregate rows (one recurrence gap listed a different partial count), so inspect the trace before treating prose counts as exact. Live runs exercised direct telemetry/event lifecycle, not creation of optional knowledge or monitoring rules; native monitor persistence and rollback are covered by focused regressions. Metrics/traces need separate live evaluation. Browser visual verification was unavailable; the configured runtime returned no browsers.

## Failures found and improvements

- The initial healthy Relay run opened a noisy medium event for one supplier timeout amid successful results. Two follow-ups kept it active. Guidance now requires operational significance, comparative outcome rates and allows closing an overstated finding without demanding a zero-error future.
- The first pricing-fault run closed that noisy event but missed the new pricing problem after using unsupported `COUNT_IF` and stopping with broad coverage unfinished. The final prompt requires checking new outcomes across observed services, repairing failed queries within the available budget, and teaches supported conditional counts.
- Later runs detected pricing failures with explicit booking impact while preserving healthy paths. The recurrence run measured pricing fail/success outcomes and reused the exact original event ID. The native alert episode ID changed on reopen, as intended.
- The healthy Sluice control and post-recovery scheduled control produced no new incident. Expected 409 duplicate and 422 validation responses were treated as declines rather than automatically as outages.

No CARL topology, fault name, handle or timeline was supplied to the target agent. It only saw configured source metadata and actual indexed telemetry. Relay was used for development; the Sluice fault was checked with the final prompt unchanged. All timestamps below are real emission time; no accelerated historical baseline was fabricated. Detection delays include manual invocation and development time and are not scheduler MTTD measurements.

## Fault timeline and identity

| Action | UTC | Result |
| --- | --- | --- |
| Relay pricing error rate 0.8 | 11:33:39.839 | First run missed; final-prompt run wrote active at 11:41:24.192 |
| Restore pricing | approximately 11:42:06 | Positive outcomes; closed at 11:45:09.927 |
| Pause Sluice consumer | 11:42:06.884 | Queue grew; delivery 503 event active at 11:45:10.792 |
| Resume consumer | approximately 11:45:49 | Jobs progressed; pending zero verified at 11:46:16/18; event closed 11:49:13.876 |
| Repeat pricing error rate 0.8 | 11:45:49.180 | Same event ID reopened at 11:49:14.766 |
| Restore pricing again | approximately 11:49:50 | Positive priced/search outcomes; closed 11:52:30.094 |
| Reset agent outputs, then native scheduled run | after recovery | Three owned event identities removed; healthy scheduled control wrote zero events |

Stable identities: `nightshift-problem-relay-pricing-price-http-500` and `nightshift-problem-sluice-delivery-queue-request-503`. The earlier noisy supplier event was closed before the successful fault runs. Exact native versions/episode IDs and per-run results are in [the machine-readable result](evaluation_2026_11_20.json).

## Run ledger

Ten completed runs cost approximately **$0.15946 in reported chat-token estimates**. This excludes embeddings (including reset-test fixture storage), cache writes, Elasticsearch compute and provider usage that was not reported. All ten run estimates were complete; the UI also has an explicit incomplete-estimate state for interrupted/unpriced usage.

| Run | ID | Outcome | Estimated chat cost |
| --- | --- | --- | --- |
| baseline | `515d62e8-fd1e-48b6-934b-c7c97378105e` | assessed | $0.01404 |
| baseline-round2 | `00ef61db-3cb9-4a2e-9c42-ee2e0c83602f` | assessed | $0.01049 |
| baseline-round3 | `d542dd18-510a-419b-ace9-63d4b3473a3b` | partial | $0.00928 |
| pricing | `b14ed4fc-91f6-4362-9096-a57288c46d95` | assessed | $0.01159 |
| estate | `335dfa74-ee8c-4cb1-a8d0-99edd5ca55d6` | partial | $0.01897 |
| queue | `2be13f08-d572-4cc4-9ae1-26e1ee646fed` | assessed | $0.01924 |
| recurrence | `11f1e056-95da-4c9f-be2e-d03f43c3e3d1` | partial | $0.02401 |
| recovered | `b3047375-36c5-4315-84ba-2daa7f94c0bb` | partial | $0.01747 |
| scheduled | `99f47637-2e8b-446d-bb54-0fb4d1177358` | nothing_new | $0.01655 |
| scheduled-repeat | `03128f03-96de-4b7c-8771-b4618113a74a` | partial | $0.01782 |

Run traces remain accessible in Agent Explorer by their IDs. Reset outputs preserves those traces and accounting.

## Controls and repository checks

- 104 backend tests in 13 suites: direct event lifecycle, fresh evidence, stable reopen identity, operator dismissal, source/window/namespace scoping, rule ownership/capacity, native persistence/rollback and workflow retirement.
- 91 frontend tests in seven suites: Run/Stop, frequency changes while disabled, no-source behavior, incomplete costs, native trace rendering, detection/settings/source-page compatibility and maintenance controls.
- Changed TypeScript lint: 56 files, no warnings/errors. Focused `tsc -p` checks passed for `significant_events` and `nightshift`. The standard dependency-building type check reports 21 existing errors in eight unchanged files in URL forwarding, workflows HITL, Context Engine and Security; it does not pass for the whole dependency graph.
- Live schedule: persisted credentialed Task Manager task, correct interval, completed scheduled invocation (`reason=hourly`), then scheduling disabled. UI frequency reset to seven minutes while remaining off.
- Live ownership reset: created clearly marked temporary agent/user KI fixtures; removed the agent fixture and preserved the user fixture, then manually deleted the remaining test fixture by storage UUID. No fabricated fixture facts were left for the agent.
- Live output reset: removed three agent-owned event identities and preserved the two source definitions, ten-run history/accounting (eight at reset time), and user-owned knowledge. No unrelated local data was migrated or deleted.

## Reproduce and retained local state

CARL sessions: Relay `616f6123-2fc2-40b3-944c-27d88d34d534`; Sluice `9c1fa933-3412-4485-bc1f-b2ace5b830f1`. Recordings: Relay `5ce120f0-02cf-415d-98f5-0d8678011ebe`; Sluice `93a9f68c-3476-47df-96f8-e9e12d338112`. Both recordings completed: Relay bundle `480ec4d7-5724-430f-9455-f97c38393d50` contains 33,135 documents; Sluice bundle `27a5c660-a75c-4e4b-b3fb-751f9f4af86a` contains 368,577. Both include healthy/fault/recovery periods. Replaying them faster does not recreate their original minute-by-minute historical baseline.

For a fresh live campaign, use CARL's operate/analyze skills: inspect sessions and supported faults; start and record an isolated Relay/Sluice run against the `kibana-dev` destination; create source views filtered by the actual `resource.attributes.carl.run_id`; run the agent through its management API or UI; save fault handles and independently verify failed/completed outcomes; revert only those handles; verify real recovery; rerun and compare stable native event IDs. Do not pass harness ground truth to the agent or score KI/rule quantity as success.

Local test sources remain enabled and the two workloads remain healthy for manual experimentation. All injected faults and temporary KI fixtures are removed; agent scheduling is off, native agent problems are empty, and run traces/cost totals remain. Existing login continues to use the role picker, with no new user/password setup.
