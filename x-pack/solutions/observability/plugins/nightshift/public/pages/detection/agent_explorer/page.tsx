/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { getEbtProps } from '@kbn/ebt-click';
import {
  EuiBadge,
  EuiBasicTable,
  EuiButton,
  EuiButtonEmpty,
  EuiCodeBlock,
  EuiConfirmModal,
  EuiEmptyPrompt,
  EuiFieldNumber,
  EuiFlexGroup,
  EuiFlexItem,
  EuiFlyout,
  EuiFlyoutBody,
  EuiFlyoutHeader,
  EuiLoadingSpinner,
  EuiPanel,
  EuiSelect,
  EuiSpacer,
  EuiStat,
  EuiSwitch,
  EuiText,
  EuiTitle,
  useEuiTheme,
} from '@elastic/eui';
import { css } from '@emotion/react';
import { buildPath } from '@kbn/core-http-browser';
import { i18n } from '@kbn/i18n';
import { useQuery, useQueryClient } from '@kbn/react-query';
import type {
  ExplorationRun,
  ExplorationStatus,
  ExplorationStep,
} from '@kbn/significant-events-plugin/common';
import { KbnDangerCallout, KbnWarningCallout } from '@kbn/ui-callout';
import React, { useEffect, useRef, useState } from 'react';
import {
  PROBLEM_AGENT_ANATOMY_QUERY_KEY,
  PROBLEM_AGENT_RUN_QUERY_KEY,
  PROBLEM_AGENT_STATUS_QUERY_KEY,
} from '../../../data/query_keys';
import { useKibana } from '../../../hooks/use_kibana';
import { RunStep } from './run_step';

const copy = {
  title: i18n.translate('xpack.nightshift.problemAgent.title', { defaultMessage: 'Problem Agent' }),
  run: i18n.translate('xpack.nightshift.problemAgent.run', { defaultMessage: 'Run now' }),
  stop: i18n.translate('xpack.nightshift.problemAgent.stop', { defaultMessage: 'Stop' }),
  model: i18n.translate('xpack.nightshift.problemAgent.model', { defaultMessage: 'Model' }),
  schedule: i18n.translate('xpack.nightshift.problemAgent.schedule', {
    defaultMessage: 'Schedule',
  }),
  minutes: i18n.translate('xpack.nightshift.problemAgent.minutes', { defaultMessage: 'Minutes' }),
  save: i18n.translate('xpack.nightshift.problemAgent.save', { defaultMessage: 'Save frequency' }),
  anatomy: i18n.translate('xpack.nightshift.problemAgent.anatomy', {
    defaultMessage: 'Agent anatomy',
  }),
  total: i18n.translate('xpack.nightshift.problemAgent.total', {
    defaultMessage: 'Total estimated cost',
  }),
  average: i18n.translate('xpack.nightshift.problemAgent.average', {
    defaultMessage: 'Average cost / run',
  }),
  runs: i18n.translate('xpack.nightshift.problemAgent.runs', { defaultMessage: 'Runs' }),
  duration: i18n.translate('xpack.nightshift.problemAgent.duration', {
    defaultMessage: 'Average duration',
  }),
  history: i18n.translate('xpack.nightshift.problemAgent.history', {
    defaultMessage: 'Run history',
  }),
  activity: i18n.translate('xpack.nightshift.problemAgent.activity', {
    defaultMessage: 'Live activity',
  }),
  resetHistory: i18n.translate('xpack.nightshift.problemAgent.resetHistory', {
    defaultMessage: 'Clear run history',
  }),
  resetTotals: i18n.translate('xpack.nightshift.problemAgent.resetTotals', {
    defaultMessage: 'Reset cost totals',
  }),
  resetOutputs: i18n.translate('xpack.nightshift.problemAgent.resetOutputs', {
    defaultMessage: 'Reset agent outputs',
  }),
  emptyTitle: i18n.translate('xpack.nightshift.problemAgent.emptyTitle', {
    defaultMessage: 'Ready to find active problems',
  }),
  emptyBody: i18n.translate('xpack.nightshift.problemAgent.emptyBody', {
    defaultMessage:
      'Configure a source, select a model, and start a run. The agent can learn the system, create monitors, and keep problems up to date.',
  }),
  noHistory: i18n.translate('xpack.nightshift.problemAgent.noHistory', {
    defaultMessage: 'Runs will appear here.',
  }),
  error: i18n.translate('xpack.nightshift.problemAgent.error', {
    defaultMessage: 'Could not complete this action',
  }),
  follow: i18n.translate('xpack.nightshift.problemAgent.follow', {
    defaultMessage: 'Follow live activity',
  }),
  models: i18n.translate('xpack.nightshift.problemAgent.models', {
    defaultMessage: 'Show model activity',
  }),
  cancel: i18n.translate('xpack.nightshift.problemAgent.cancel', { defaultMessage: 'Cancel' }),
  confirm: i18n.translate('xpack.nightshift.problemAgent.confirm', { defaultMessage: 'Reset' }),
};
const money = (amount: number) => '$' + amount.toFixed(4);
const duration = (ms: number) => Math.round(ms / 1000) + 's';
interface Anatomy {
  name: string;
  systemPrompt: string;
  tools: Array<{ name: string; description?: string; schema: object }>;
  limits: object;
  persistence: string[];
  costEstimate: string;
}

export const AgentExplorer = (): React.ReactElement => {
  const { http } = useKibana().services;
  const { euiTheme } = useEuiTheme();
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string>();
  const [frequency, setFrequency] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [showAnatomy, setShowAnatomy] = useState(false);
  const [inspect, setInspect] = useState<ExplorationStep>();
  const [reset, setReset] = useState<'runs' | 'totals' | 'outputs'>();
  const [showModels, setShowModels] = useState(true);
  const [followLive, setFollowLive] = useState(true);
  const activity = useRef<HTMLDivElement>(null);
  const status = useQuery({
    queryKey: PROBLEM_AGENT_STATUS_QUERY_KEY,
    queryFn: ({ signal }) =>
      http.get<ExplorationStatus>('/internal/significant_events/problem_agent', { signal }),
    refetchInterval: 2000,
  });
  const data = status.data;
  const activeId = selectedId ?? data?.runningRunId ?? data?.runs[0]?.id;
  const detail = useQuery({
    queryKey: [...PROBLEM_AGENT_RUN_QUERY_KEY, activeId],
    queryFn: ({ signal }) =>
      http.get<ExplorationRun>(
        buildPath('/internal/significant_events/problem_agent/runs/{runId}', {
          runId: activeId ?? '',
        }),
        { signal }
      ),
    enabled: Boolean(activeId),
    refetchInterval: 2000,
  });
  const anatomy = useQuery({
    queryKey: PROBLEM_AGENT_ANATOMY_QUERY_KEY,
    queryFn: ({ signal }) =>
      http.get<Anatomy>('/internal/significant_events/problem_agent/anatomy', { signal }),
    enabled: showAnatomy,
  });
  const run = detail.data;
  const running = Boolean(data?.runningRunId);
  const frequencyValue = frequency ?? String(data?.intervalMinutes ?? 60);
  const intervalMinutes = Number(frequencyValue);
  const validFrequency =
    Number.isInteger(intervalMinutes) && intervalMinutes >= 1 && intervalMinutes <= 10080;
  useEffect(() => {
    if (followLive && activity.current) activity.current.scrollTop = activity.current.scrollHeight;
  }, [run?.steps.length, run?.summary, followLive]);

  const act = async <T,>(action: () => Promise<T>): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
      await queryClient.invalidateQueries({ queryKey: PROBLEM_AGENT_STATUS_QUERY_KEY });
      await queryClient.invalidateQueries({ queryKey: PROBLEM_AGENT_RUN_QUERY_KEY });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  const steps = (run?.steps ?? []).filter((step) => showModels || step.kind === 'tool');
  let previousTool: ExplorationStep | undefined;
  return (
    <div
      data-test-subj="nightshiftProblemAgentExplorer"
      css={css`
        overflow: auto;
        min-height: 0;
        padding: ${euiTheme.size.s};
      `}
    >
      {Boolean(error || status.error) && (
        <>
          <KbnDangerCallout
            title={copy.error}
            text={
              error ?? (status.error instanceof Error ? status.error.message : String(status.error))
            }
          />
          <EuiSpacer />
        </>
      )}
      {data?.costEstimateComplete === false && (
        <>
          <KbnWarningCallout
            title={i18n.translate('xpack.nightshift.problemAgent.incompleteEstimate', {
              defaultMessage: 'Cost estimate incomplete',
            })}
            text={i18n.translate('xpack.nightshift.problemAgent.incompleteEstimateDescription', {
              defaultMessage:
                'Some requests have missing usage or pricing. The displayed total can understate incurred model charges.',
            })}
          />
          <EuiSpacer />
        </>
      )}
      <EuiPanel hasBorder>
        <EuiFlexGroup alignItems="center" wrap>
          <EuiFlexItem grow={false}>
            <EuiTitle size="s">
              <h2>{copy.title}</h2>
            </EuiTitle>
          </EuiFlexItem>
          <EuiFlexItem grow={false}>
            <EuiBadge color={running ? 'primary' : 'hollow'}>
              {running
                ? i18n.translate('xpack.nightshift.problemAgent.running', {
                    defaultMessage: 'Running',
                  })
                : i18n.translate('xpack.nightshift.problemAgent.idle', { defaultMessage: 'Idle' })}
            </EuiBadge>
          </EuiFlexItem>
          <EuiFlexItem>
            <EuiSelect
              {...getEbtProps({ action: 'agentExplorer1', element: 'problemAgent' })}
              data-test-subj="nightshiftAgentExplorerSelect"
              aria-label={copy.model}
              value={data?.connectorId ?? ''}
              options={(data?.availableModels ?? []).map(({ connectorId, model }) => ({
                value: connectorId,
                text: model,
              }))}
              disabled={busy || running}
              onChange={(event) => {
                void act(() =>
                  http.put('/internal/significant_events/problem_agent/model', {
                    body: JSON.stringify({ connectorId: event.target.value }),
                  })
                );
              }}
            />
          </EuiFlexItem>
          <EuiFlexItem grow={false}>
            <EuiButtonEmpty
              {...getEbtProps({ action: 'agentExplorer2', element: 'problemAgent' })}
              data-test-subj="nightshiftAgentExplorerButton"
              onClick={() => setShowAnatomy(true)}
            >
              {copy.anatomy}
            </EuiButtonEmpty>
          </EuiFlexItem>
        </EuiFlexGroup>
        <EuiSpacer size="m" />
        <EuiFlexGroup alignItems="center" wrap>
          <EuiFlexItem grow={false}>
            <EuiSwitch
              id="nightshift-agent-schedule"
              label={copy.schedule}
              checked={data?.enabled ?? false}
              disabled={busy || !data}
              onChange={(event) => {
                void act(() =>
                  http.put('/internal/significant_events/problem_agent/settings', {
                    body: JSON.stringify({
                      enabled: event.target.checked,
                      intervalMinutes: data?.intervalMinutes ?? 60,
                    }),
                  })
                );
              }}
            />
          </EuiFlexItem>
          <EuiFlexItem grow={false}>
            <EuiFieldNumber
              data-test-subj="nightshiftAgentExplorerFieldNumber"
              aria-label={copy.minutes}
              value={frequencyValue}
              min={1}
              max={10080}
              step={1}
              isInvalid={!validFrequency}
              onChange={(event) => setFrequency(event.target.value)}
              compressed
            />
          </EuiFlexItem>
          <EuiFlexItem grow={false}>
            <EuiButtonEmpty
              {...getEbtProps({ action: 'agentExplorer3', element: 'problemAgent' })}
              data-test-subj="nightshiftAgentExplorerButton"
              disabled={busy || !validFrequency || !data}
              onClick={() => {
                void act(async () => {
                  await http.put('/internal/significant_events/problem_agent/settings', {
                    body: JSON.stringify({ enabled: data?.enabled ?? false, intervalMinutes }),
                  });
                  setFrequency(undefined);
                });
              }}
            >
              {copy.save}
            </EuiButtonEmpty>
          </EuiFlexItem>
          <EuiFlexItem />
          <EuiFlexItem grow={false}>
            <EuiButton
              {...getEbtProps({ action: 'agentExplorer4', element: 'problemAgent' })}
              data-test-subj="nightshiftAgentExplorerButton"
              fill
              disabled={
                busy || !data || (!running && !data.sources.some((source) => source.enabled))
              }
              color={running ? 'danger' : 'primary'}
              onClick={() => {
                setSelectedId(undefined);
                void act(() =>
                  http.post(
                    running
                      ? '/internal/significant_events/problem_agent/_cancel'
                      : '/internal/significant_events/problem_agent/_run'
                  )
                );
              }}
            >
              {running ? copy.stop : copy.run}
            </EuiButton>
          </EuiFlexItem>
        </EuiFlexGroup>
        <EuiSpacer />
        <EuiFlexGroup wrap>
          <EuiFlexItem>
            <EuiStat
              title={money(data?.totalCostUsd ?? 0)}
              description={copy.total}
              titleSize="s"
            />
          </EuiFlexItem>
          <EuiFlexItem>
            <EuiStat
              title={money(
                (data?.totalCostUsd ?? 0) / Math.max(1, (data?.totalRuns ?? 0) + (running ? 1 : 0))
              )}
              description={copy.average}
              titleSize="s"
            />
          </EuiFlexItem>
          <EuiFlexItem>
            <EuiStat title={data?.totalRuns ?? 0} description={copy.runs} titleSize="s" />
          </EuiFlexItem>
          <EuiFlexItem>
            <EuiStat
              title={duration(data?.averageRunDurationMs ?? 0)}
              description={copy.duration}
              titleSize="s"
            />
          </EuiFlexItem>
        </EuiFlexGroup>
      </EuiPanel>
      <EuiSpacer />
      {!data?.sources.some((source) => source.enabled) && (
        <EuiEmptyPrompt
          iconType="magnify"
          title={<h3>{copy.emptyTitle}</h3>}
          body={copy.emptyBody}
        />
      )}
      <EuiFlexGroup alignItems="flexStart" wrap>
        <EuiFlexItem grow={1}>
          <EuiPanel hasBorder>
            <EuiTitle size="xs">
              <h3>{copy.history}</h3>
            </EuiTitle>
            <EuiSpacer size="s" />
            <EuiBasicTable
              tableCaption={copy.history}
              items={data?.runs ?? []}
              noItemsMessage={copy.noHistory}
              rowProps={(item) => ({
                onClick: () => setSelectedId(item.id),
                'data-test-subj': 'problemAgentRun-' + item.id,
              })}
              columns={[
                {
                  field: 'startedAt',
                  name: i18n.translate('xpack.nightshift.problemAgent.started', {
                    defaultMessage: 'Started',
                  }),
                  render: (value: string, item: ExplorationRun) => (
                    <EuiButtonEmpty
                      {...getEbtProps({ action: 'agentExplorer5', element: 'problemAgent' })}
                      data-test-subj="nightshiftAgentExplorerButton"
                      size="xs"
                      onClick={() => setSelectedId(item.id)}
                    >
                      {new Date(value).toLocaleString()}
                    </EuiButtonEmpty>
                  ),
                },
                {
                  field: 'status',
                  name: i18n.translate('xpack.nightshift.problemAgent.status', {
                    defaultMessage: 'Status',
                  }),
                },
                {
                  field: 'estimatedCostUsd',
                  name: i18n.translate('xpack.nightshift.problemAgent.cost', {
                    defaultMessage: 'Est. cost',
                  }),
                  render: (value: number) => money(value),
                },
              ]}
            />
            <EuiSpacer />
            <EuiButtonEmpty
              {...getEbtProps({ action: 'agentExplorer6', element: 'problemAgent' })}
              data-test-subj="nightshiftAgentExplorerButton"
              size="xs"
              onClick={() => setReset('runs')}
              disabled={busy}
            >
              {copy.resetHistory}
            </EuiButtonEmpty>
            <EuiButtonEmpty
              {...getEbtProps({ action: 'agentExplorer7', element: 'problemAgent' })}
              data-test-subj="nightshiftAgentExplorerButton"
              size="xs"
              onClick={() => setReset('totals')}
              disabled={busy}
            >
              {copy.resetTotals}
            </EuiButtonEmpty>
            <EuiButtonEmpty
              {...getEbtProps({ action: 'agentExplorer8', element: 'problemAgent' })}
              data-test-subj="nightshiftAgentExplorerButton"
              size="xs"
              color="danger"
              onClick={() => setReset('outputs')}
              disabled={busy}
            >
              {copy.resetOutputs}
            </EuiButtonEmpty>
          </EuiPanel>
        </EuiFlexItem>
        <EuiFlexItem grow={2}>
          <EuiPanel hasBorder>
            <EuiFlexGroup alignItems="center" wrap>
              <EuiFlexItem>
                <EuiTitle size="xs">
                  <h3>{copy.activity}</h3>
                </EuiTitle>
              </EuiFlexItem>
              <EuiFlexItem grow={false}>
                <EuiSwitch
                  compressed
                  label={copy.models}
                  checked={showModels}
                  onChange={(event) => setShowModels(event.target.checked)}
                />
              </EuiFlexItem>
              <EuiFlexItem grow={false}>
                <EuiSwitch
                  compressed
                  label={copy.follow}
                  checked={followLive}
                  onChange={(event) => setFollowLive(event.target.checked)}
                />
              </EuiFlexItem>
            </EuiFlexGroup>
            {run && (
              <>
                <EuiSpacer size="m" />
                <EuiText size="s">
                  <p>{run.summary}</p>
                </EuiText>
                <EuiFlexGroup gutterSize="s">
                  <EuiFlexItem grow={false}>
                    <EuiBadge>{run.status}</EuiBadge>
                  </EuiFlexItem>
                  <EuiFlexItem grow={false}>
                    <EuiBadge>
                      {money(run.estimatedCostUsd)}
                      {run.costEstimateComplete === false ? ' *' : ''}
                    </EuiBadge>
                  </EuiFlexItem>
                  <EuiFlexItem grow={false}>
                    <EuiBadge>
                      {duration(
                        Date.parse(run.finishedAt ?? new Date().toISOString()) -
                          Date.parse(run.startedAt)
                      )}
                    </EuiBadge>
                  </EuiFlexItem>
                </EuiFlexGroup>
              </>
            )}
            <div
              ref={activity}
              css={css`
                max-height: 65vh;
                overflow: auto;
              `}
            >
              {steps.map((step) => {
                const preceding = previousTool;
                if (step.kind === 'tool') previousTool = step;
                return (
                  <RunStep
                    key={step.id}
                    step={step}
                    previousTool={preceding}
                    onInspect={() => setInspect(step)}
                  />
                );
              })}
              {running && <EuiLoadingSpinner />}
            </div>
            {run?.remainingGaps?.length ? (
              <>
                <EuiSpacer />
                <EuiText size="s">
                  <ul>
                    {run.remainingGaps.map((gap) => (
                      <li key={gap}>{gap}</li>
                    ))}
                  </ul>
                </EuiText>
              </>
            ) : null}
          </EuiPanel>
        </EuiFlexItem>
      </EuiFlexGroup>
      {showAnatomy && (
        <EuiFlyout onClose={() => setShowAnatomy(false)} size="l" aria-label={copy.anatomy}>
          <EuiFlyoutHeader>
            <EuiTitle>
              <h2>{copy.anatomy}</h2>
            </EuiTitle>
          </EuiFlyoutHeader>
          <EuiFlyoutBody>
            {anatomy.data ? (
              <>
                <EuiCodeBlock language="text" isCopyable>
                  {anatomy.data.systemPrompt}
                </EuiCodeBlock>
                <EuiSpacer />
                <EuiCodeBlock language="json" isCopyable>
                  {JSON.stringify(
                    {
                      tools: anatomy.data.tools,
                      limits: anatomy.data.limits,
                      persistence: anatomy.data.persistence,
                      costEstimate: anatomy.data.costEstimate,
                    },
                    null,
                    2
                  )}
                </EuiCodeBlock>
              </>
            ) : (
              <EuiLoadingSpinner />
            )}
          </EuiFlyoutBody>
        </EuiFlyout>
      )}
      {inspect && (
        <EuiFlyout onClose={() => setInspect(undefined)} size="l" aria-label={inspect.name}>
          <EuiFlyoutHeader>
            <EuiTitle>
              <h2>{inspect.name}</h2>
            </EuiTitle>
          </EuiFlyoutHeader>
          <EuiFlyoutBody>
            <EuiCodeBlock language="json" isCopyable>
              {inspect.input}
            </EuiCodeBlock>
            <EuiSpacer />
            <EuiCodeBlock language="json" isCopyable>
              {inspect.output}
            </EuiCodeBlock>
          </EuiFlyoutBody>
        </EuiFlyout>
      )}
      {reset && (
        <EuiConfirmModal
          aria-label={
            reset === 'runs'
              ? copy.resetHistory
              : reset === 'totals'
              ? copy.resetTotals
              : copy.resetOutputs
          }
          title={
            reset === 'runs'
              ? copy.resetHistory
              : reset === 'totals'
              ? copy.resetTotals
              : copy.resetOutputs
          }
          onCancel={() => setReset(undefined)}
          cancelButtonText={copy.cancel}
          confirmButtonText={copy.confirm}
          buttonColor="danger"
          onConfirm={() => {
            const mode = reset;
            setReset(undefined);
            void act(async () => {
              await http.post(
                mode === 'runs'
                  ? '/internal/significant_events/problem_agent/_reset_runs'
                  : mode === 'totals'
                  ? '/internal/significant_events/problem_agent/_reset_totals'
                  : '/internal/significant_events/problem_agent/_reset_outputs',
                {
                  body: JSON.stringify({
                    confirmation:
                      mode === 'runs'
                        ? 'RESET RUN HISTORY'
                        : mode === 'totals'
                        ? 'RESET TOTALS'
                        : 'RESET AGENT OUTPUTS',
                  }),
                }
              );
              setSelectedId(undefined);
            });
          }}
        >
          <EuiText size="s">
            <p>{modeResetDescription(reset)}</p>
          </EuiText>
        </EuiConfirmModal>
      )}
    </div>
  );
};

const modeResetDescription = (mode: 'runs' | 'totals' | 'outputs'): string =>
  mode === 'outputs'
    ? i18n.translate('xpack.nightshift.problemAgent.resetOutputsDescription', {
        defaultMessage:
          'Stops the agent and removes its knowledge, owned monitors and problem assessments in this space. Sources and user-created rules are preserved.',
      })
    : mode === 'runs'
    ? i18n.translate('xpack.nightshift.problemAgent.resetRunsDescription', {
        defaultMessage:
          'Stops the agent and clears run traces and displayed cost totals. Knowledge, rules and problems are preserved. Incurred model charges remain.',
      })
    : i18n.translate('xpack.nightshift.problemAgent.resetTotalsDescription', {
        defaultMessage:
          'Stops the agent and resets displayed cost totals. Run history and outputs are preserved. Incurred model charges remain.',
      });
