/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { getEbtProps } from '@kbn/ebt-click';
import {
  euiMaxBreakpoint,
  EuiBadge,
  EuiBasicTable,
  EuiButton,
  EuiButtonEmpty,
  EuiCheckbox,
  EuiConfirmModal,
  EuiEmptyPrompt,
  EuiFieldNumber,
  EuiFlexGroup,
  EuiFlexItem,
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
import { KbnDangerCallout } from '@kbn/ui-callout';
import React, { useEffect, useRef, useState } from 'react';
import {
  PROBLEM_AGENT_RUN_QUERY_KEY,
  PROBLEM_AGENT_STATUS_QUERY_KEY,
} from '../../../data/query_keys';
import { useKibana } from '../../../hooks/use_kibana';
import { RunStep } from './run_step';
import { groupActivity, specialistName, SpecialistActivity } from './specialist_activity';

const copy = {
  title: i18n.translate('xpack.nightshift.problemAgent.title', {
    defaultMessage: 'Detection Agent',
  }),
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
const AgentAnatomy = React.lazy(async () => ({
  default: (await import('./agent_anatomy')).AgentAnatomy,
}));

export const AgentExplorer = (): React.ReactElement => {
  const { http } = useKibana().services;
  const theme = useEuiTheme();
  const { euiTheme } = theme;
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string>();
  const [frequency, setFrequency] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [showAnatomy, setShowAnatomy] = useState(false);
  const [selectedOutputs, setSelectedOutputs] = useState<string[]>([]);
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
  const run = detail.data;
  const running = Boolean(data?.runningRunId);
  const frequencyValue = frequency ?? String(data?.intervalMinutes ?? 60);
  const intervalMinutes = Number(frequencyValue);
  const validFrequency =
    Number.isInteger(intervalMinutes) && intervalMinutes >= 1 && intervalMinutes <= 10080;
  useEffect(() => {
    if (followLive && activity.current) activity.current.scrollTop = activity.current.scrollHeight;
  }, [run?.steps, run?.summary, showModels, followLive]);

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
  const selectRun = (id: string) => {
    setFollowLive(false);
    setSelectedId(id);
    if (activity.current) activity.current.scrollTop = 0;
  };
  const panelStyles = css`
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  `;
  const scrollStyles = css`
    flex: 1 1 0;
    min-height: 0;
    overflow: auto;
    overscroll-behavior: contain;
    scrollbar-gutter: stable;
  `;
  const groups = groupActivity(run?.steps ?? []);
  const waiting =
    run?.status === 'running' &&
    groups.find(({ step }) => step.name === 'delegate_specialist' && step.status === 'running')
      ?.step;
  const pauseFollowing = () => setFollowLive(false);
  let previousTool: ExplorationStep | undefined;
  return (
    <div
      data-test-subj="nightshiftProblemAgentExplorer"
      css={css`
        display: flex;
        flex: 1 1 0;
        flex-direction: column;
        min-width: 0;
        min-height: 0;
        overflow: hidden;
        gap: ${euiTheme.size.m};
        padding: ${euiTheme.size.s};
      `}
    >
      <div
        css={css`
          flex: 0 0 auto;
          max-height: 50%;
          overflow: auto;
        `}
      >
        {Boolean(error || status.error) && (
          <>
            <KbnDangerCallout
              title={copy.error}
              text={
                error ??
                (status.error instanceof Error ? status.error.message : String(status.error))
              }
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
                  : i18n.translate('xpack.nightshift.problemAgent.idle', {
                      defaultMessage: 'Idle',
                    })}
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
                  (data?.totalCostUsd ?? 0) /
                    Math.max(1, (data?.totalRuns ?? 0) + (running ? 1 : 0))
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
        {!data?.sources.some((source) => source.enabled) && (
          <EuiEmptyPrompt
            iconType="magnify"
            title={<h3>{copy.emptyTitle}</h3>}
            body={copy.emptyBody}
          />
        )}
      </div>
      <div
        css={css`
          display: grid;
          grid-template-columns: minmax(${euiTheme.base * 22}px, 1fr) minmax(0, 2fr);
          grid-template-rows: minmax(0, 1fr);
          gap: ${euiTheme.size.m};
          flex: 1 1 0;
          min-height: 0;

          ${euiMaxBreakpoint(theme, 'm')} {
            grid-template-columns: minmax(0, 1fr);
            grid-template-rows: minmax(0, 1fr) minmax(0, 2fr);
          }
        `}
      >
        <EuiPanel hasBorder css={panelStyles}>
          <EuiTitle size="xs">
            <h3>{copy.history}</h3>
          </EuiTitle>
          <EuiSpacer size="s" />
          <div role="region" aria-label={copy.history} tabIndex={0} css={scrollStyles}>
            <EuiBasicTable
              tableCaption={copy.history}
              responsiveBreakpoint={false}
              items={data?.runs ?? []}
              noItemsMessage={copy.noHistory}
              rowProps={(item) => ({
                onClick: () => selectRun(item.id),
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
                      onClick={() => selectRun(item.id)}
                      title={new Date(value).toLocaleString()}
                    >
                      {new Date(value).toLocaleString()}
                    </EuiButtonEmpty>
                  ),
                },
                {
                  field: 'status',
                  width: `${euiTheme.base * 6}px`,
                  truncateText: true,
                  name: i18n.translate('xpack.nightshift.problemAgent.status', {
                    defaultMessage: 'Status',
                  }),
                },
                {
                  field: 'estimatedCostUsd',
                  width: `${euiTheme.base * 6}px`,
                  textOnly: true,
                  truncateText: true,
                  name: i18n.translate('xpack.nightshift.problemAgent.cost', {
                    defaultMessage: 'Est. cost',
                  }),
                  render: (value: number, item: ExplorationRun) =>
                    `${money(value)}${item.costEstimateComplete === false ? ' *' : ''}`,
                },
              ]}
            />
          </div>
          <div>
            <EuiSpacer size="s" />
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
              onClick={() => {
                setSelectedOutputs([]);
                setReset('outputs');
              }}
              disabled={busy}
            >
              {copy.resetOutputs}
            </EuiButtonEmpty>
          </div>
        </EuiPanel>
        <EuiPanel hasBorder css={panelStyles}>
          <EuiFlexGroup
            alignItems="center"
            wrap
            css={css`
              flex: 0 0 auto;
            `}
          >
            <EuiFlexItem>
              <EuiTitle size="xs">
                <h3>{copy.activity}</h3>
              </EuiTitle>
            </EuiFlexItem>
            <EuiFlexItem grow={false}>
              <EuiSwitch
                compressed
                data-test-subj="nightshiftAgentExplorerShowModels"
                label={copy.models}
                checked={showModels}
                onChange={(event) => setShowModels(event.target.checked)}
              />
            </EuiFlexItem>
            <EuiFlexItem grow={false}>
              <EuiSwitch
                compressed
                label={copy.follow}
                data-test-subj="nightshiftAgentExplorerFollowLive"
                checked={followLive}
                onChange={(event) => setFollowLive(event.target.checked)}
              />
            </EuiFlexItem>
          </EuiFlexGroup>
          <EuiSpacer size="m" />
          {waiting && (
            <EuiText size="s" role="status">
              <strong>
                {i18n.translate('xpack.nightshift.specialist.waiting', {
                  defaultMessage: 'Detection Agent is waiting for {name}',
                  values: { name: specialistName(waiting) },
                })}
              </strong>
            </EuiText>
          )}
          <div
            ref={activity}
            role="region"
            aria-label={copy.activity}
            tabIndex={0}
            css={scrollStyles}
            onScroll={(event) => {
              const { scrollHeight, scrollTop, clientHeight } = event.currentTarget;
              if (scrollHeight - scrollTop - clientHeight > euiTheme.base) {
                setFollowLive(false);
              }
            }}
          >
            {run && (
              <>
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
            {groups.map(({ step, children }) => {
              if (step.kind === 'model' && !showModels) return null;
              if (step.name === 'delegate_specialist') {
                previousTool = step;
                return (
                  <SpecialistActivity
                    key={step.id}
                    step={step}
                    childrenSteps={children}
                    showModels={showModels}
                    onInspect={pauseFollowing}
                  />
                );
              }
              const preceding = previousTool;
              if (step.kind === 'tool') previousTool = step;
              return (
                <RunStep
                  key={step.id}
                  step={step}
                  previousTool={preceding}
                  onInspect={pauseFollowing}
                />
              );
            })}
            {run?.status === 'running' && <EuiLoadingSpinner />}
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
          </div>
        </EuiPanel>
      </div>
      {showAnatomy && (
        <React.Suspense fallback={<EuiLoadingSpinner />}>
          <AgentAnatomy onClose={() => setShowAnatomy(false)} />
        </React.Suspense>
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
          confirmButtonDisabled={reset === 'outputs' && !selectedOutputs.length}
          confirmButtonText={
            reset === 'outputs'
              ? i18n.translate('xpack.nightshift.problemAgent.deleteSelected', {
                  defaultMessage: 'Delete selected outputs',
                })
              : copy.confirm
          }
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
                    ...(mode === 'outputs' ? { outputs: selectedOutputs } : {}),
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
          {reset === 'outputs' && (
            <>
              <EuiSpacer size="s" />
              {Object.entries(outputLabels).map(([value, label]) => (
                <EuiCheckbox
                  key={value}
                  id={'nightshift-reset-' + value}
                  label={label}
                  checked={selectedOutputs.includes(value)}
                  onChange={(event) => {
                    const checked = event.target.checked;
                    setSelectedOutputs((previous) =>
                      checked ? [...previous, value] : previous.filter((item) => item !== value)
                    );
                  }}
                />
              ))}
            </>
          )}
        </EuiConfirmModal>
      )}
    </div>
  );
};

const outputLabels = {
  knowledge: i18n.translate('xpack.nightshift.problemAgent.deleteKnowledge', {
    defaultMessage: 'Knowledge indicators (features and standalone queries)',
  }),
  rules: i18n.translate('xpack.nightshift.problemAgent.deleteRules', {
    defaultMessage: 'Monitoring rules and their backing queries',
  }),
  events: i18n.translate('xpack.nightshift.problemAgent.deleteEvents', {
    defaultMessage: 'Significant events and their history',
  }),
};

const modeResetDescription = (mode: 'runs' | 'totals' | 'outputs'): string =>
  mode === 'outputs'
    ? i18n.translate('xpack.nightshift.problemAgent.resetOutputsDescription', {
        defaultMessage:
          'Choose which agent outputs to delete in this space. Deletion stops the active run. Scheduled runs can create new outputs.',
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
