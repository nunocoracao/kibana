/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { css } from '@emotion/react';
import {
  EuiBadge,
  EuiButton,
  EuiButtonEmpty,
  EuiConfirmModal,
  EuiEmptyPrompt,
  EuiFlexGroup,
  EuiFlexItem,
  EuiButtonIcon,
  EuiToolTip,
  EuiPanel,
  EuiSelect,
  EuiSpacer,
  EuiIcon,
  EuiSwitch,
  EuiFieldNumber,
  EuiText,
  EuiTitle,
  EuiBasicTable,
  EuiLink,
  useEuiTheme,
} from '@elastic/eui';
import { KbnDangerCallout } from '@kbn/ui-callout';
import { i18n } from '@kbn/i18n';
import { useQuery, useQueryClient } from '@kbn/react-query';
import type {
  ExplorationRun,
  ExplorationStatus,
  ExplorationStep,
} from '@kbn/significant-events-plugin/common';
import { AnatomyDrawer } from './anatomy_drawer';
import { RunStep } from './run_step';
import { getStepDescription } from './step_summary';
import { useKibana } from '../../hooks/use_kibana';
import { AgentExplorerNavigation } from '../../components/agent_explorer_navigation';
import {
  SignificantEventsAppHeader,
  SignificantEventsAppPageTemplate,
} from '../../components/page_template';

const copy = {
  anatomy: i18n.translate('xpack.significantEventsApp.knowledgeExplorer.anatomy.button', {
    defaultMessage: 'Agent anatomy',
  }),
  resetTotals: i18n.translate('xpack.significantEventsApp.knowledgeExplorer.resetTotals', {
    defaultMessage: 'Reset totals',
  }),
  resetTotalsTitle: i18n.translate(
    'xpack.significantEventsApp.knowledgeExplorer.resetTotalsTitle',
    { defaultMessage: 'Reset estimated cost and token totals?' }
  ),
  resetTotalsBody: i18n.translate('xpack.significantEventsApp.knowledgeExplorer.resetTotalsBody', {
    defaultMessage:
      'Stops any active run and starts the displayed totals at zero for this space. Run history, knowledge indicators and checkpoints are preserved. This does not erase model usage charges.',
  }),

  deleteRun: i18n.translate('xpack.significantEventsApp.knowledgeExplorer.deleteRun', {
    defaultMessage: 'Delete run',
  }),
  resetRuns: i18n.translate('xpack.significantEventsApp.knowledgeExplorer.resetRuns', {
    defaultMessage: 'Reset run history',
  }),
  deleteRunTitle: i18n.translate('xpack.significantEventsApp.knowledgeExplorer.deleteRunTitle', {
    defaultMessage: 'Delete this run?',
  }),
  deleteRunBody: i18n.translate('xpack.significantEventsApp.knowledgeExplorer.deleteRunBody', {
    defaultMessage:
      'Stops this run if it is active and removes its trace from this space. Its incurred cost remains in the total. Knowledge indicators are preserved.',
  }),
  resetRunsTitle: i18n.translate('xpack.significantEventsApp.knowledgeExplorer.resetRunsTitle', {
    defaultMessage: 'Reset run history and cost totals?',
  }),
  resetRunsBody: i18n.translate('xpack.significantEventsApp.knowledgeExplorer.resetRunsBody', {
    defaultMessage:
      'Stops the active run and clears every run trace and the displayed cost and token totals in this space. This does not erase model usage charges. Knowledge indicators and novelty checkpoints are preserved.',
  }),

  title: i18n.translate('xpack.significantEventsApp.knowledgeExplorer.title', {
    defaultMessage: 'Agent Explorer',
  }),
  management: i18n.translate('xpack.significantEventsApp.knowledgeExplorer.management', {
    defaultMessage: 'Nightshift Management',
  }),
  run: i18n.translate('xpack.significantEventsApp.knowledgeExplorer.run', {
    defaultMessage: 'Run now',
  }),
  stop: i18n.translate('xpack.significantEventsApp.knowledgeExplorer.stop', {
    defaultMessage: 'Stop run',
  }),
  reset: i18n.translate('xpack.significantEventsApp.knowledgeExplorer.reset', {
    defaultMessage: 'Reset feature KIs',
  }),
  schedule: i18n.translate('xpack.significantEventsApp.knowledgeExplorer.schedule', {
    defaultMessage: 'Scheduled runs',
  }),
  frequency: i18n.translate('xpack.significantEventsApp.knowledgeExplorer.frequency', {
    defaultMessage: 'Run frequency in minutes',
  }),
  saveFrequency: i18n.translate('xpack.significantEventsApp.knowledgeExplorer.saveFrequency', {
    defaultMessage: 'Save frequency',
  }),
  thinking: i18n.translate('xpack.significantEventsApp.knowledgeExplorer.thinking', {
    defaultMessage: 'Thinking on',
  }),
  total: i18n.translate('xpack.significantEventsApp.knowledgeExplorer.total', {
    defaultMessage: 'Total cost',
  }),
  average: i18n.translate('xpack.significantEventsApp.knowledgeExplorer.averageRunCost', {
    defaultMessage: 'Avg. cost / run',
  }),
  runDuration: i18n.translate('xpack.significantEventsApp.agentPanel.runDuration', {
    defaultMessage: 'Run duration',
  }),
  averageRunDuration: i18n.translate('xpack.significantEventsApp.agentPanel.averageRunDuration', {
    defaultMessage: 'Avg. duration',
  }),
  stored: i18n.translate('xpack.significantEventsApp.knowledgeExplorer.stored', {
    defaultMessage: 'Feature KIs',
  }),
  resetSuccess: i18n.translate('xpack.significantEventsApp.knowledgeExplorer.resetSuccess', {
    defaultMessage: 'Feature knowledge reset',
  }),
  writes: i18n.translate('xpack.significantEventsApp.knowledgeExplorer.writes', {
    defaultMessage: 'KI writes this run',
  }),
  sources: i18n.translate('xpack.significantEventsApp.knowledgeExplorer.sources', {
    defaultMessage: 'Sources',
  }),
  history: i18n.translate('xpack.significantEventsApp.knowledgeExplorer.history', {
    defaultMessage: 'Run history',
  }),
  activity: i18n.translate('xpack.significantEventsApp.knowledgeExplorer.activity', {
    defaultMessage: 'Live exploration',
  }),
  empty: i18n.translate('xpack.significantEventsApp.knowledgeExplorer.empty', {
    defaultMessage: 'Ready to discover your system',
  }),
  emptyBody: i18n.translate('xpack.significantEventsApp.knowledgeExplorer.emptyBody', {
    defaultMessage:
      'Add a detection source or start a run. The agent checks for new evidence, explores gaps, and stops when there is nothing new to learn.',
  }),
  noHistory: i18n.translate('xpack.significantEventsApp.knowledgeExplorer.noHistory', {
    defaultMessage: 'Your runs will appear here.',
  }),
  details: i18n.translate('xpack.significantEventsApp.knowledgeExplorer.details', {
    defaultMessage: 'Inspect tool call',
  }),
  input: i18n.translate('xpack.significantEventsApp.knowledgeExplorer.input', {
    defaultMessage: 'Input',
  }),
  output: i18n.translate('xpack.significantEventsApp.knowledgeExplorer.output', {
    defaultMessage: 'Result',
  }),
  error: i18n.translate('xpack.significantEventsApp.knowledgeExplorer.error', {
    defaultMessage: 'Could not complete this action',
  }),
  resetTitle: i18n.translate('xpack.significantEventsApp.knowledgeExplorer.resetTitle', {
    defaultMessage: 'Reset feature knowledge in this space?',
  }),
  resetBody: i18n.translate('xpack.significantEventsApp.knowledgeExplorer.resetBody', {
    defaultMessage:
      'Deletes extracted feature KIs and clears novelty checkpoints for this space. Queries, rules, sources, run history and cost totals are preserved. The next run explores from scratch.',
  }),
  cancel: i18n.translate('xpack.significantEventsApp.knowledgeExplorer.cancel', {
    defaultMessage: 'Cancel',
  }),
  costNote: i18n.translate('xpack.significantEventsApp.knowledgeExplorer.costNote', {
    defaultMessage:
      'Costs are estimates from reported model tokens and per-run model rates; they are not your Elastic bill. Cached input is discounted. Estimates exclude cache writes, embeddings and Elasticsearch compute. Thinking tokens are shown only when the provider reports them.',
  }),
  reasoning: i18n.translate('xpack.significantEventsApp.knowledgeExplorer.reasoning', {
    defaultMessage: 'Thinking about the next step',
  }),
  sourceTool: i18n.translate('xpack.significantEventsApp.knowledgeExplorer.sourceTool', {
    defaultMessage: 'Discover detection sources',
  }),
  queryTool: i18n.translate('xpack.significantEventsApp.knowledgeExplorer.queryTool', {
    defaultMessage: 'Explore source evidence',
  }),
  contextTool: i18n.translate('xpack.significantEventsApp.knowledgeExplorer.contextTool', {
    defaultMessage: 'Read Kibana context',
  }),
  knowledgeTool: i18n.translate('xpack.significantEventsApp.knowledgeExplorer.knowledgeTool', {
    defaultMessage: 'Read or write knowledge',
  }),
  finishTool: i18n.translate('xpack.significantEventsApp.knowledgeExplorer.finishTool', {
    defaultMessage: 'Complete exploration',
  }),
};
const dollars = (value = 0) => `$${value.toFixed(4)}`;
const formatDuration = (durationMs: number): string => {
  const seconds = Math.max(0, durationMs) / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
};
const durationForRun = (run: ExplorationRun): number => {
  const started = Date.parse(run.startedAt);
  const ended = run.finishedAt ? Date.parse(run.finishedAt) : Date.now();
  return Number.isFinite(started) && Number.isFinite(ended) ? Math.max(0, ended - started) : 0;
};
export function KnowledgeExplorationPage() {
  const [agent, setAgent] = useState<'knowledge' | 'monitoring' | 'events'>(() =>
    new URLSearchParams(window.location.search).get('agent') === 'events'
      ? 'events'
      : new URLSearchParams(window.location.search).get('agent') === 'monitoring'
      ? 'monitoring'
      : 'knowledge'
  );
  return <AgentPanel key={agent} agent={agent} onAgentChange={setAgent} />;
}

function AgentPanel({
  agent,
  onAgentChange,
}: {
  agent: 'knowledge' | 'monitoring' | 'events';
  onAgentChange: (agent: 'knowledge' | 'monitoring' | 'events') => void;
}) {
  const monitoring = agent === 'monitoring';
  const events = agent === 'events';
  const outcomeLabel = (item: ExplorationRun): string =>
    item.status !== 'completed'
      ? item.status
      : monitoring && item.outcome === 'learned'
      ? 'configured'
      : monitoring && item.outcome === 'nothing_new'
      ? 'unchanged'
      : (item.outcome ?? item.status).replaceAll('_', ' ');
  const { euiTheme } = useEuiTheme();
  const { core, dependencies } = useKibana();
  const client = dependencies.start.significantEvents.significantEventsRepositoryClient;
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string>();
  const [frequencyDraft, setFrequencyDraft] = useState<string>();
  const [showAnatomy, setShowAnatomy] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [confirmResetRuns, setConfirmResetRuns] = useState(false);
  const [confirmResetTotals, setConfirmResetTotals] = useState(false);
  const [deleteId, setDeleteId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const [showModelActivity, setShowModelActivity] = useState(true);
  const [issuesOnly, setIssuesOnly] = useState(false);
  const [followLive, setFollowLive] = useState(true);
  const activityRef = useRef<HTMLDivElement>(null);
  const status = useQuery<ExplorationStatus, Error>({
    queryKey: ['agent-explorer-status', agent],
    queryFn: ({ signal }) =>
      client.fetch(
        events
          ? 'GET /internal/significant_events/event_discovery'
          : monitoring
          ? 'GET /internal/significant_events/monitoring_setup'
          : 'GET /internal/significant_events/knowledge_exploration',
        {
          signal: signal ?? null,
        }
      ),
    refetchInterval: 2000,
    refetchOnWindowFocus: true,
  });
  const frequencyValue = frequencyDraft ?? String(status.data?.intervalMinutes ?? 60);
  const frequencyMinutes = Number(frequencyValue);
  const validFrequency =
    frequencyValue.trim() !== '' &&
    Number.isInteger(frequencyMinutes) &&
    frequencyMinutes >= 1 &&
    frequencyMinutes <= 10080;
  const activeId = selectedId ?? status.data?.runningRunId ?? status.data?.runs[0]?.id;
  const detail = useQuery<ExplorationRun, Error>({
    queryKey: ['agent-explorer-run', agent, activeId],
    queryFn: ({ signal }) =>
      client.fetch(
        events
          ? 'GET /internal/significant_events/event_discovery/runs/{runId}'
          : monitoring
          ? 'GET /internal/significant_events/monitoring_setup/runs/{runId}'
          : 'GET /internal/significant_events/knowledge_exploration/runs/{runId}',
        {
          params: { path: { runId: activeId ?? '' } },
          signal: signal ?? null,
        }
      ),
    enabled: Boolean(activeId),
    refetchInterval: 2000,
  });
  const run = detail.data;
  const running = Boolean(status.data?.runningRunId);
  const annotatedSteps = useMemo(() => {
    let previousTool: ExplorationStep | undefined;
    return (run?.steps ?? []).map((step) => {
      const row = { step, previousTool };
      if (step.kind === 'tool') previousTool = step;
      return row;
    });
  }, [run?.steps]);
  const visibleSteps = annotatedSteps.filter(
    ({ step }) =>
      (showModelActivity || step.kind !== 'model') &&
      (!issuesOnly || ['failed', 'partial'].includes(getStepDescription(step).status))
  );
  const latestStep = run?.steps.at(-1);
  const issueCount = annotatedSteps.filter(({ step }) =>
    ['failed', 'partial'].includes(getStepDescription(step).status)
  ).length;
  useEffect(() => {
    if (followLive && run?.status === 'running' && activityRef.current)
      activityRef.current.scrollTop = activityRef.current.scrollHeight;
  }, [
    followLive,
    run?.id,
    run?.status,
    run?.steps.length,
    latestStep?.status,
    showModelActivity,
    issuesOnly,
  ]);
  useEffect(() => {
    core.chrome.setBreadcrumbs([
      { text: copy.management, href: core.application.getUrlForApp('significant_events') },
      { text: copy.title },
    ]);
  }, [core]);
  const act = async (action: () => Promise<object>) => {
    setBusy(true);
    setActionError(undefined);
    try {
      await action();
      await status.refetch();
      void queryClient.invalidateQueries({ queryKey: ['agent-explorer-run', agent] });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const costRunCount = (status.data?.totalRuns ?? 0) + (status.data?.runningRunId ? 1 : 0);
  const averageRunCost = costRunCount > 0 ? (status.data?.totalCostUsd ?? 0) / costRunCount : 0;
  const stats = [
    {
      title:
        status.data?.costEstimateComplete === false
          ? `${dollars(status.data.totalCostUsd)}+`
          : dollars(status.data?.totalCostUsd),
      description: copy.total,
    },
    {
      title:
        status.data?.costEstimateComplete === false
          ? `${dollars(averageRunCost)}+`
          : dollars(averageRunCost),
      description: copy.average,
    },
    {
      title: run ? formatDuration(durationForRun(run)) : '—',
      description: copy.runDuration,
    },
    {
      title: status.data?.totalRuns ? formatDuration(status.data.averageRunDurationMs) : '—',
      description: copy.averageRunDuration,
    },
    {
      title: status.data?.featureCount ?? 0,
      description: events ? 'Assessments' : monitoring ? 'Managed rules' : copy.stored,
    },
    {
      title: status.data?.sources.filter((source) => source.enabled).length ?? 0,
      description: copy.sources,
    },
  ];
  return (
    <>
      <SignificantEventsAppHeader
        title={copy.title}
        back={{ label: copy.management, href: core.application.getUrlForApp('significant_events') }}
      />
      <SignificantEventsAppPageTemplate.Body grow>
        <div
          css={css`
            display: flex;
            flex-direction: column;
            gap: ${euiTheme.size.m};
            min-height: 0;
            height: 100%;
          `}
        >
          <AgentExplorerNavigation agent={agent} onAgentChange={onAgentChange} />
          <EuiPanel
            paddingSize="m"
            grow={false}
            hasShadow={false}
            hasBorder
            css={css`
              flex: 0 0 auto;
              min-height: 0;
              height: auto;
            `}
          >
            <EuiFlexGroup alignItems="center" gutterSize="s" wrap responsive={false}>
              <EuiFlexItem grow={false}>
                <EuiBadge color="primary" iconType="sparkles">
                  {copy.thinking}
                </EuiBadge>
              </EuiFlexItem>
              <EuiFlexItem grow={false}>
                <EuiBadge color={running ? 'success' : 'hollow'}>
                  {running ? 'Running' : 'Idle'}
                </EuiBadge>
              </EuiFlexItem>
              <EuiFlexItem
                css={css`
                  flex: 1 1 200px;
                  min-width: 180px;
                  max-width: 320px;
                `}
              >
                <EuiToolTip
                  content={i18n.translate(
                    'xpack.significantEventsApp.knowledgeExploration.futureModel',
                    {
                      defaultMessage:
                        'Model for future runs. The active run keeps its original model.',
                    }
                  )}
                >
                  <EuiSelect
                    data-test-subj="significantEventsAppKnowledgeExplorationPageSelect"
                    compressed
                    aria-label={i18n.translate(
                      'xpack.significantEventsApp.knowledgeExploration.modelLabel',
                      { defaultMessage: 'Model for future runs' }
                    )}
                    value={status.data?.connectorId ?? ''}
                    options={[
                      ...(status.data?.availableModels ?? []).map(({ connectorId, model }) => ({
                        value: connectorId,
                        text: model,
                      })),
                      ...((status.data?.availableModels ?? []).some(({ model }) =>
                        /haiku.*5[.-]5|5[.-]5.*haiku/i.test(model)
                      )
                        ? []
                        : [
                            {
                              value: 'unavailable-haiku-5.5',
                              text: 'Claude Haiku 5.5 — unavailable in this deployment',
                              disabled: true,
                            },
                          ]),
                    ]}
                    disabled={busy || !status.data}
                    onChange={(event) => {
                      const connectorId = event.target.value;
                      void act(() =>
                        client.fetch(
                          events
                            ? 'PUT /internal/significant_events/event_discovery/model'
                            : monitoring
                            ? 'PUT /internal/significant_events/monitoring_setup/model'
                            : 'PUT /internal/significant_events/knowledge_exploration/model',
                          { params: { body: { connectorId } }, signal: null }
                        )
                      );
                    }}
                  />
                </EuiToolTip>
              </EuiFlexItem>
              <EuiFlexItem grow={false}>
                <EuiButtonEmpty
                  data-test-subj="significantEventsAppKnowledgeExplorationPageButton"
                  iconType="inspect"
                  size="xs"
                  aria-label={copy.anatomy}
                  onClick={() => setShowAnatomy(true)}
                >
                  {i18n.translate('xpack.significantEventsApp.agentPanel.anatomyShortLabel', {
                    defaultMessage: 'Anatomy',
                  })}
                </EuiButtonEmpty>
              </EuiFlexItem>
              <EuiFlexItem grow={false}>
                <EuiButtonEmpty
                  data-test-subj="significantEventsAppAgentPanelAgentBuilderButton"
                  size="xs"
                  iconType="external"
                  href={core.application.getUrlForApp('agent_builder', {
                    path: `/agents/nightshift-v2-${
                      events
                        ? 'event-discovery'
                        : monitoring
                        ? 'monitoring-setup'
                        : 'knowledge-extractor'
                    }`,
                  })}
                >
                  {i18n.translate(
                    'xpack.significantEventsApp.agentPanel.agentBuilderButtonEmptyLabel',
                    { defaultMessage: 'Agent Builder' }
                  )}
                </EuiButtonEmpty>
              </EuiFlexItem>
            </EuiFlexGroup>
            <EuiSpacer size="s" />
            <EuiFlexGroup alignItems="center" gutterSize="s" wrap responsive={false}>
              <EuiFlexItem grow={false}>
                <EuiSwitch
                  compressed
                  label={copy.schedule}
                  checked={status.data?.enabled ?? false}
                  disabled={busy || !status.data}
                  onChange={(event) => {
                    const enabled = event.target.checked;
                    void act(() =>
                      client.fetch(
                        events
                          ? 'PUT /internal/significant_events/event_discovery/settings'
                          : monitoring
                          ? 'PUT /internal/significant_events/monitoring_setup/settings'
                          : 'PUT /internal/significant_events/knowledge_exploration/settings',
                        {
                          params: {
                            body: { enabled, intervalMinutes: status.data?.intervalMinutes ?? 60 },
                          },
                          signal: null,
                        }
                      )
                    );
                  }}
                />
              </EuiFlexItem>
              <EuiFlexItem grow={false}>
                <EuiFieldNumber
                  compressed
                  aria-label={copy.frequency}
                  data-test-subj="significantEventsAppAgentFrequencyMinutes"
                  value={frequencyValue}
                  min={1}
                  max={10080}
                  step={1}
                  append="min"
                  css={css`
                    width: 104px;
                  `}
                  disabled={busy || !status.data}
                  isInvalid={!validFrequency}
                  onChange={(event) => setFrequencyDraft(event.target.value)}
                />
              </EuiFlexItem>
              <EuiFlexItem grow={false}>
                <EuiButtonEmpty
                  size="xs"
                  aria-label={copy.saveFrequency}
                  data-test-subj="significantEventsAppSaveAgentFrequency"
                  disabled={
                    busy ||
                    !status.data ||
                    !validFrequency ||
                    frequencyMinutes === status.data.intervalMinutes
                  }
                  onClick={() =>
                    void act(async () => {
                      const result = await client.fetch(
                        events
                          ? 'PUT /internal/significant_events/event_discovery/settings'
                          : monitoring
                          ? 'PUT /internal/significant_events/monitoring_setup/settings'
                          : 'PUT /internal/significant_events/knowledge_exploration/settings',
                        {
                          params: {
                            body: {
                              enabled: status.data?.enabled ?? false,
                              intervalMinutes: frequencyMinutes,
                            },
                          },
                          signal: null,
                        }
                      );
                      setFrequencyDraft(undefined);
                      return result;
                    })
                  }
                >
                  {i18n.translate(
                    'xpack.significantEventsApp.knowledgeExplorer.saveFrequencyLabel',
                    { defaultMessage: 'Save' }
                  )}
                </EuiButtonEmpty>
              </EuiFlexItem>
              <EuiFlexItem grow={false}>
                <EuiButtonEmpty
                  data-test-subj="significantEventsAppKnowledgeExplorationPageButton"
                  iconType="refresh"
                  size="xs"
                  disabled={running || busy || !status.data}
                  onClick={() => setConfirmReset(true)}
                >
                  {events
                    ? 'Reset event assessments'
                    : monitoring
                    ? 'Reset managed rules'
                    : copy.reset}
                </EuiButtonEmpty>
              </EuiFlexItem>
              <EuiFlexItem />
              <EuiFlexItem grow={false}>
                {running ? (
                  <EuiButton
                    size="s"
                    data-test-subj="significantEventsAppKnowledgeExplorationPageButton"
                    iconType="stop"
                    color="warning"
                    disabled={busy}
                    onClick={() =>
                      void act(() =>
                        client.fetch(
                          events
                            ? 'POST /internal/significant_events/event_discovery/_cancel'
                            : monitoring
                            ? 'POST /internal/significant_events/monitoring_setup/_cancel'
                            : 'POST /internal/significant_events/knowledge_exploration/_cancel',
                          { signal: null }
                        )
                      )
                    }
                  >
                    {copy.stop}
                  </EuiButton>
                ) : (
                  <EuiButton
                    size="s"
                    data-test-subj="significantEventsAppKnowledgeExplorationPageButton"
                    fill
                    iconType="play"
                    isLoading={busy}
                    disabled={!status.data || !status.data.sources.some((source) => source.enabled)}
                    onClick={() =>
                      void act(async () => {
                        const started = await client.fetch(
                          events
                            ? 'POST /internal/significant_events/event_discovery/_run'
                            : monitoring
                            ? 'POST /internal/significant_events/monitoring_setup/_run'
                            : 'POST /internal/significant_events/knowledge_exploration/_run',
                          { signal: null }
                        );
                        setSelectedId(started.id);
                        setFollowLive(true);
                        return started;
                      })
                    }
                  >
                    {copy.run}
                  </EuiButton>
                )}
              </EuiFlexItem>
            </EuiFlexGroup>
            <div
              css={css`
                display: flex;
                gap: ${euiTheme.size.s};
                align-items: center;
                border-top: ${euiTheme.border.thin};
                margin-top: ${euiTheme.size.m};
                padding-top: ${euiTheme.size.m};
              `}
            >
              <dl
                css={css`
                  display: grid;
                  grid-template-columns: repeat(6, minmax(0, 1fr));
                  gap: ${euiTheme.size.m};
                  flex: 1;
                  min-width: 0;
                  margin: 0;
                  @media (max-width: 640px) {
                    grid-template-columns: repeat(3, minmax(0, 1fr));
                  }
                `}
              >
                {stats.map((stat) => (
                  <div key={stat.description}>
                    <dt
                      css={css`
                        font-size: ${euiTheme.font.scale.xs}rem;
                        color: ${euiTheme.colors.textSubdued};
                        margin-bottom: ${euiTheme.size.xs};
                        white-space: nowrap;
                      `}
                    >
                      {stat.description === copy.total ? (
                        <EuiToolTip content={copy.costNote}>
                          <span tabIndex={0}>
                            {stat.description} <EuiIcon type="info" size="s" aria-hidden={true} />
                          </span>
                        </EuiToolTip>
                      ) : (
                        stat.description
                      )}
                    </dt>
                    <dd
                      css={css`
                        font-size: ${euiTheme.font.scale.l}rem;
                        font-weight: ${euiTheme.font.weight.semiBold};
                        font-variant-numeric: tabular-nums;
                        line-height: 1.3;
                        margin: 0;
                      `}
                    >
                      {stat.title}
                    </dd>
                  </div>
                ))}
              </dl>
              <EuiToolTip content={copy.resetTotals} disableScreenReaderOutput>
                <EuiButtonIcon
                  data-test-subj="significantEventsAppKnowledgeExplorationPageButton"
                  aria-label={copy.resetTotals}
                  iconType="refresh"
                  disabled={busy || !status.data}
                  onClick={() => setConfirmResetTotals(true)}
                />
              </EuiToolTip>
            </div>
          </EuiPanel>
          {(actionError || status.error || detail.error) && (
            <KbnDangerCallout announceOnMount title={copy.error} size="s">
              <p>{actionError ?? status.error?.message ?? detail.error?.message}</p>
            </KbnDangerCallout>
          )}
          <EuiPanel
            paddingSize="none"
            hasBorder
            hasShadow={false}
            css={css`
              display: grid;
              grid-template-columns: 212px minmax(0, 1fr);
              flex: 1;
              min-height: 0;
              overflow: hidden;
              @media (max-width: 700px) {
                grid-template-columns: 1fr;
              }
            `}
          >
            <aside
              aria-label={copy.history}
              css={css`
                display: flex;
                flex-direction: column;
                min-height: 0;
                border-right: ${euiTheme.border.thin};
                background: ${euiTheme.colors.backgroundBaseSubdued};
                @media (max-width: 700px) {
                  border-right: 0;
                  border-bottom: ${euiTheme.border.thin};
                  max-height: 220px;
                }
              `}
            >
              <div
                css={css`
                  display: flex;
                  align-items: center;
                  justify-content: space-between;
                  padding: ${euiTheme.size.m};
                  border-bottom: ${euiTheme.border.thin};
                  min-height: 56px;
                `}
              >
                <EuiTitle size="xxs">
                  <h2>{copy.history}</h2>
                </EuiTitle>
                <EuiToolTip content={copy.resetRuns} disableScreenReaderOutput>
                  <EuiButtonIcon
                    data-test-subj="significantEventsAppKnowledgeExplorationPageButton"
                    aria-label={copy.resetRuns}
                    iconType="refresh"
                    disabled={busy || !status.data}
                    onClick={() => setConfirmResetRuns(true)}
                  />
                </EuiToolTip>
              </div>
              <div
                css={css`
                  overflow-y: auto;
                  flex: 1;
                  min-height: 0;
                `}
              >
                {!status.data?.runs.length && (
                  <EuiText
                    size="s"
                    color="subdued"
                    css={css`
                      padding: ${euiTheme.size.m};
                    `}
                  >
                    {copy.noHistory}
                  </EuiText>
                )}
                {status.data?.runs.map((item) => (
                  <div
                    key={item.id}
                    css={css`
                      position: relative;
                    `}
                  >
                    <button
                      type="button"
                      onClick={() => setSelectedId(item.id)}
                      aria-current={activeId === item.id ? 'true' : undefined}
                      title={
                        status.data?.availableModels.find(
                          (model) => model.connectorId === item.connectorId
                        )?.model ?? item.model
                      }
                      css={css`
                        display: block;
                        width: 100%;
                        text-align: left;
                        padding: ${euiTheme.size.m} 32px ${euiTheme.size.m} ${euiTheme.size.m};
                        border: 0;
                        border-bottom: ${euiTheme.border.thin};
                        border-left: 2px solid
                          ${activeId === item.id ? euiTheme.colors.primary : 'transparent'};
                        background: ${activeId === item.id
                          ? `color-mix(in srgb, ${euiTheme.colors.primary} 8%, ${euiTheme.colors.backgroundBasePlain})`
                          : 'transparent'};
                        color: ${euiTheme.colors.textParagraph};
                        cursor: pointer;
                        &:hover {
                          background: ${euiTheme.colors.backgroundBasePlain};
                        }
                        &:focus-visible {
                          outline: ${euiTheme.focus.width} solid ${euiTheme.colors.primary};
                          outline-offset: -2px;
                        }
                      `}
                    >
                      <EuiFlexGroup
                        gutterSize="s"
                        alignItems="center"
                        justifyContent="spaceBetween"
                        responsive={false}
                      >
                        <EuiFlexItem>
                          <EuiText size="s">
                            <strong>
                              {new Date(item.startedAt).toLocaleTimeString([], {
                                hour: '2-digit',
                                minute: '2-digit',
                              })}
                            </strong>
                          </EuiText>
                        </EuiFlexItem>
                        <EuiFlexItem grow={false}>
                          <EuiBadge
                            color={
                              item.status === 'failed'
                                ? 'danger'
                                : item.outcome === 'partial'
                                ? 'warning'
                                : item.status === 'running'
                                ? 'primary'
                                : 'hollow'
                            }
                          >
                            {outcomeLabel(item)}
                          </EuiBadge>
                        </EuiFlexItem>
                      </EuiFlexGroup>
                      <EuiText
                        size="xs"
                        color="subdued"
                        css={css`
                          margin-top: ${euiTheme.size.xs};
                          line-height: 1.6;
                        `}
                      >
                        {new Date(item.startedAt).toLocaleDateString()} ·{' '}
                        {item.reason.replaceAll('_', ' ')}
                        <br />
                        {dollars(item.estimatedCostUsd)} · {formatDuration(durationForRun(item))} ·{' '}
                        {item.written} {events ? 'events' : monitoring ? 'rules' : 'KIs'}
                      </EuiText>
                    </button>
                    <EuiToolTip content={copy.deleteRun} disableScreenReaderOutput>
                      <EuiButtonIcon
                        data-test-subj="significantEventsAppKnowledgeExplorationPageButton"
                        iconType="trash"
                        color="text"
                        aria-label={copy.deleteRun}
                        disabled={busy}
                        onClick={() => setDeleteId(item.id)}
                        css={css`
                          position: absolute;
                          right: 4px;
                          top: 12px;
                        `}
                      />
                    </EuiToolTip>
                  </div>
                ))}
              </div>
            </aside>
            <div
              css={css`
                display: flex;
                flex-direction: column;
                min-width: 0;
                min-height: 0;
              `}
            >
              {!run ? (
                <EuiEmptyPrompt
                  iconType="machineLearningApp"
                  title={
                    <h2>
                      {events
                        ? 'Ready to assess recent rule firings'
                        : monitoring
                        ? 'Ready to assess monitoring coverage'
                        : copy.empty}
                    </h2>
                  }
                  body={
                    <p>
                      {monitoring
                        ? 'Run manually to review configured sources, existing monitoring and blind spots.'
                        : copy.emptyBody}
                    </p>
                  }
                />
              ) : (
                <>
                  <header
                    css={css`
                      flex: 0 0 auto;
                      padding: ${euiTheme.size.m} ${euiTheme.size.l};
                      border-bottom: ${euiTheme.border.thin};
                      background: ${euiTheme.colors.backgroundBasePlain};
                    `}
                  >
                    <EuiFlexGroup
                      alignItems="center"
                      justifyContent="spaceBetween"
                      gutterSize="s"
                      responsive={false}
                    >
                      <EuiFlexItem>
                        <EuiTitle size="xxs">
                          <h2>{run.status === 'running' ? 'Live activity' : 'Run activity'}</h2>
                        </EuiTitle>
                      </EuiFlexItem>
                      <EuiFlexItem grow={false}>
                        <EuiBadge color={run.status === 'running' ? 'primary' : 'hollow'}>
                          {outcomeLabel(run)}
                        </EuiBadge>
                      </EuiFlexItem>
                    </EuiFlexGroup>
                    <EuiText
                      size="xs"
                      color="subdued"
                      css={css`
                        margin-top: ${euiTheme.size.xs};
                        overflow: hidden;
                        white-space: nowrap;
                        text-overflow: ellipsis;
                      `}
                      title={
                        status.data?.availableModels.find(
                          (model) => model.connectorId === run.connectorId
                        )?.model ?? run.model
                      }
                    >
                      {status.data?.availableModels.find(
                        (model) => model.connectorId === run.connectorId
                      )?.model ?? run.model}{' '}
                      · {new Date(run.startedAt).toLocaleString()}
                    </EuiText>
                    <EuiText
                      size="xs"
                      color="subdued"
                      css={css`
                        margin-top: 4px;
                      `}
                    >
                      {run.steps.filter((step) => step.kind === 'tool').length}{' '}
                      {i18n.translate('xpack.significantEventsApp.agentPanel.toolCallsTextLabel', {
                        defaultMessage: 'tool calls ·',
                      })}
                      {run.steps.filter((step) => step.kind === 'model').length}{' '}
                      {i18n.translate('xpack.significantEventsApp.agentPanel.modelTurnsTextLabel', {
                        defaultMessage: 'model turns ·',
                      })}
                      {issueCount > 0 && (
                        <>
                          {issueCount}{' '}
                          {i18n.translate('xpack.significantEventsApp.agentPanel.issuesTextLabel', {
                            defaultMessage: 'issues ·',
                          })}
                        </>
                      )}
                      {run.written}{' '}
                      {events ? 'event updates' : monitoring ? 'rule changes' : 'KI writes'} ·{' '}
                      {formatDuration(durationForRun(run))} · {dollars(run.estimatedCostUsd)}
                    </EuiText>
                    {run.summary && (
                      <EuiText
                        size="xs"
                        color="subdued"
                        css={css`
                          margin-top: 4px;
                          display: -webkit-box;
                          -webkit-line-clamp: 2;
                          -webkit-box-orient: vertical;
                          overflow: hidden;
                        `}
                        title={run.summary}
                      >
                        {run.summary}
                      </EuiText>
                    )}
                    <EuiSpacer size="s" />
                    <EuiFlexGroup gutterSize="m" wrap alignItems="center" responsive={false}>
                      <EuiFlexItem grow={false}>
                        <EuiSwitch
                          compressed
                          label={i18n.translate(
                            'xpack.significantEventsApp.agentPanel.euiSwitch.modelActivityLabel',
                            { defaultMessage: 'Commentary' }
                          )}
                          checked={showModelActivity}
                          onChange={(event) => setShowModelActivity(event.target.checked)}
                        />
                      </EuiFlexItem>
                      <EuiFlexItem grow={false}>
                        <EuiSwitch
                          compressed
                          label={i18n.translate(
                            'xpack.significantEventsApp.agentPanel.euiSwitch.issuesOnlyLabel',
                            { defaultMessage: 'Issues only' }
                          )}
                          checked={issuesOnly}
                          onChange={(event) => setIssuesOnly(event.target.checked)}
                        />
                      </EuiFlexItem>
                      {run.status === 'running' && (
                        <EuiFlexItem grow={false}>
                          <EuiSwitch
                            compressed
                            label={i18n.translate(
                              'xpack.significantEventsApp.agentPanel.euiSwitch.followLiveLabel',
                              { defaultMessage: 'Follow live' }
                            )}
                            checked={followLive}
                            onChange={(event) => setFollowLive(event.target.checked)}
                          />
                        </EuiFlexItem>
                      )}
                    </EuiFlexGroup>
                  </header>
                  <div
                    ref={activityRef}
                    onScroll={(event) => {
                      const element = event.currentTarget;
                      if (element.scrollHeight - element.clientHeight - element.scrollTop >= 60)
                        setFollowLive(false);
                    }}
                    css={css`
                      overflow-y: auto;
                      flex: 1;
                      min-height: 0;
                      padding: 0 ${euiTheme.size.l} ${euiTheme.size.l};
                      scrollbar-gutter: stable;
                    `}
                    aria-label={copy.activity}
                    role="region"
                  >
                    {monitoring && Boolean(run.coverage?.length) && (
                      <>
                        <EuiPanel paddingSize="m" hasBorder>
                          <EuiTitle size="xs">
                            <h3>
                              {i18n.translate(
                                'xpack.significantEventsApp.agentPanel.h3.monitoringCoverageLabel',
                                { defaultMessage: 'Monitoring coverage' }
                              )}
                            </h3>
                          </EuiTitle>
                          <EuiSpacer size="s" />
                          <EuiBasicTable
                            tableCaption="Monitoring coverage for configured sources"
                            items={run.coverage ?? []}
                            columns={[
                              {
                                field: 'entity',
                                name: 'Entity',
                                width: '18%',
                                render: (
                                  entity: string,
                                  item: NonNullable<ExplorationRun['coverage']>[number]
                                ) => (
                                  <>
                                    <strong>{entity}</strong>
                                    <EuiText size="xs" color="subdued">
                                      {status.data?.sources.find(
                                        (source) => source.id === item.sourceId
                                      )?.title ?? item.sourceId}
                                    </EuiText>
                                  </>
                                ),
                              },
                              { field: 'concern', name: 'Concern', width: '22%' },
                              {
                                field: 'priority',
                                name: 'Priority',
                                width: '12%',
                                render: (
                                  priority: string | undefined,
                                  item: NonNullable<ExplorationRun['coverage']>[number]
                                ) => (
                                  <EuiToolTip content={item.priorityReason}>
                                    <EuiBadge
                                      tabIndex={0}
                                      color={priority === 'high' ? 'warning' : 'hollow'}
                                    >
                                      {priority ?? 'Not assessed'}
                                    </EuiBadge>
                                  </EuiToolTip>
                                ),
                              },
                              {
                                field: 'state',
                                name: 'Coverage',
                                width: '15%',
                                render: (state: string) => (
                                  <EuiBadge
                                    color={
                                      state === 'covered'
                                        ? 'success'
                                        : state === 'blind_spot'
                                        ? 'warning'
                                        : 'hollow'
                                    }
                                  >
                                    {state.replaceAll('_', ' ')}
                                  </EuiBadge>
                                ),
                              },
                              {
                                field: 'evidence',
                                name: 'Evidence / monitors',
                                render: (
                                  evidence: string,
                                  item: NonNullable<ExplorationRun['coverage']>[number]
                                ) => (
                                  <>
                                    <EuiText size="s">{evidence}</EuiText>
                                    {item.ruleIds.map((id, index) => (
                                      <EuiLink
                                        data-test-subj="significantEventsAppAgentPanelLink"
                                        key={id}
                                        href={core.application.getUrlForApp('significant_events', {
                                          path: `/detection?view=rules&source=${encodeURIComponent(
                                            item.sourceId
                                          )}&ruleId=${encodeURIComponent(id)}`,
                                        })}
                                      >
                                        {i18n.translate(
                                          'xpack.significantEventsApp.agentPanel.monitorLinkLabel',
                                          { defaultMessage: 'Monitor' }
                                        )}
                                        {index + 1}{' '}
                                      </EuiLink>
                                    ))}
                                  </>
                                ),
                              },
                            ]}
                          />
                        </EuiPanel>
                        <EuiSpacer size="l" />
                      </>
                    )}
                    {visibleSteps.map(({ step, previousTool }) => (
                      <RunStep
                        key={step.id}
                        step={step}
                        previousTool={previousTool}
                        onInspect={() => setFollowLive(false)}
                      />
                    ))}
                    {!visibleSteps.length && (
                      <EuiText size="s" color="subdued">
                        {issuesOnly
                          ? 'No recorded issues in this run.'
                          : 'Waiting for the first action…'}
                      </EuiText>
                    )}
                    {Boolean(run.remainingGaps?.length) && (
                      <EuiPanel paddingSize="s" hasBorder hasShadow={false}>
                        <EuiText size="s">
                          <strong>
                            {i18n.translate(
                              'xpack.significantEventsApp.agentPanel.strong.remainingQuestionsLabel',
                              { defaultMessage: 'Remaining questions' }
                            )}
                          </strong>
                        </EuiText>
                        <EuiText size="xs">
                          <ul>
                            {run.remainingGaps?.map((gap) => (
                              <li key={gap}>{gap}</li>
                            ))}
                          </ul>
                        </EuiText>
                      </EuiPanel>
                    )}
                    {run.error && <KbnDangerCallout announceOnMount title={run.error} size="s" />}
                  </div>
                </>
              )}
            </div>
          </EuiPanel>
        </div>
      </SignificantEventsAppPageTemplate.Body>
      {showAnatomy && <AnatomyDrawer agent={agent} onClose={() => setShowAnatomy(false)} />}
      {confirmResetTotals && (
        <EuiConfirmModal
          aria-label={copy.resetTotalsTitle}
          title={copy.resetTotalsTitle}
          buttonColor="danger"
          confirmButtonText={copy.resetTotals}
          cancelButtonText={copy.cancel}
          onCancel={() => setConfirmResetTotals(false)}
          onConfirm={() => {
            setConfirmResetTotals(false);
            void act(() =>
              client.fetch(
                events
                  ? 'POST /internal/significant_events/event_discovery/_reset_totals'
                  : monitoring
                  ? 'POST /internal/significant_events/monitoring_setup/_reset_totals'
                  : 'POST /internal/significant_events/knowledge_exploration/_reset_totals',
                { params: { body: { confirmation: 'RESET TOTALS' } }, signal: null }
              )
            );
          }}
        >
          <p>{copy.resetTotalsBody}</p>
        </EuiConfirmModal>
      )}
      {confirmReset && (
        <EuiConfirmModal
          aria-label={copy.resetTitle}
          title={
            events
              ? 'Reset this agent’s event assessments?'
              : monitoring
              ? 'Reset this agent’s managed rules?'
              : copy.resetTitle
          }
          onCancel={() => setConfirmReset(false)}
          onConfirm={() => {
            setConfirmReset(false);
            void act(async () => {
              const result = events
                ? await client.fetch('POST /internal/significant_events/event_discovery/_reset', {
                    params: { body: { confirmation: 'RESET DISCOVERY EVENTS' } },
                    signal: null,
                  })
                : monitoring
                ? await client.fetch('POST /internal/significant_events/monitoring_setup/_reset', {
                    params: { body: { confirmation: 'RESET MONITORING RULES' } },
                    signal: null,
                  })
                : await client.fetch(
                    'POST /internal/significant_events/knowledge_exploration/_reset',
                    { params: { body: { confirmation: 'RESET FEATURE KNOWLEDGE' } }, signal: null }
                  );
              core.notifications.toasts.addSuccess({
                title: copy.resetSuccess,
                text: `${result.features} ${
                  events ? 'event assessments' : monitoring ? 'managed rules' : 'feature KIs'
                } removed`,
              });
              void queryClient.invalidateQueries();
              return result;
            });
          }}
          confirmButtonText={
            events ? 'Reset event assessments' : monitoring ? 'Reset managed rules' : copy.reset
          }
          cancelButtonText={copy.cancel}
          buttonColor="danger"
        >
          <p>
            {events
              ? 'Removes only this agent’s native active/inactive event assessments. Sources, KIs, rules and user alerts remain.'
              : monitoring
              ? 'Removes only this agent’s native rules and their generated query references. KIs, user rules and other Kibana objects are preserved.'
              : copy.resetBody}
          </p>
        </EuiConfirmModal>
      )}
      {deleteId && (
        <EuiConfirmModal
          aria-label={copy.deleteRunTitle}
          title={copy.deleteRunTitle}
          buttonColor="danger"
          confirmButtonText={copy.deleteRun}
          cancelButtonText={copy.cancel}
          onCancel={() => setDeleteId(undefined)}
          onConfirm={() => {
            const id = deleteId;
            setDeleteId(undefined);
            void act(async () => {
              const result = await client.fetch(
                events
                  ? 'DELETE /internal/significant_events/event_discovery/runs/{runId}'
                  : monitoring
                  ? 'DELETE /internal/significant_events/monitoring_setup/runs/{runId}'
                  : 'DELETE /internal/significant_events/knowledge_exploration/runs/{runId}',
                { params: { path: { runId: id } }, signal: null }
              );
              if (selectedId === id) setSelectedId(undefined);
              return result;
            });
          }}
        >
          <p>{copy.deleteRunBody}</p>
        </EuiConfirmModal>
      )}
      {confirmResetRuns && (
        <EuiConfirmModal
          aria-label={copy.resetRunsTitle}
          title={copy.resetRunsTitle}
          buttonColor="danger"
          confirmButtonText={copy.resetRuns}
          cancelButtonText={copy.cancel}
          onCancel={() => setConfirmResetRuns(false)}
          onConfirm={() => {
            setConfirmResetRuns(false);
            void act(async () => {
              const result = await client.fetch(
                events
                  ? 'POST /internal/significant_events/event_discovery/runs/_reset'
                  : monitoring
                  ? 'POST /internal/significant_events/monitoring_setup/runs/_reset'
                  : 'POST /internal/significant_events/knowledge_exploration/runs/_reset',
                { params: { body: { confirmation: 'RESET RUN HISTORY' } }, signal: null }
              );
              setSelectedId(undefined);
              return result;
            });
          }}
        >
          <p>{copy.resetRunsBody}</p>
        </EuiConfirmModal>
      )}
    </>
  );
}
