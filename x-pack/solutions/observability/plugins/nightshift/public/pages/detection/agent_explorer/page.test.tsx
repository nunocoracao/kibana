/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */
import React from 'react';
import { EuiProvider } from '@elastic/eui';
import { I18nProvider } from '@kbn/i18n-react';
import { QueryClient, QueryClientProvider } from '@kbn/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ExplorationStatus, ExplorationRun } from '@kbn/significant-events-plugin/common';
import { PROBLEM_AGENT_RUN_QUERY_KEY } from '../../../data/query_keys';
import { AgentExplorer } from './page';

const mockHttp = { get: jest.fn(), post: jest.fn(), put: jest.fn() };
jest.mock('../../../hooks/use_kibana', () => ({
  useKibana: () => ({ services: { http: mockHttp } }),
}));
let status: ExplorationStatus;
let run: ExplorationRun;
let client: QueryClient;

beforeEach(() => {
  jest.clearAllMocks();
  const tokens = { prompt: 0, completion: 0, thinking: 0, cached: 0, total: 0 };
  status = {
    enabled: false,
    interval: '60m',
    intervalMinutes: 60,
    thinking: true,
    model: 'Test model',
    connectorId: 'model',
    availableModels: [{ connectorId: 'model', model: 'Test model' }],
    runs: [],
    totalRuns: 0,
    totalCostUsd: 0,
    totalRunDurationMs: 0,
    averageRunDurationMs: 0,
    totalTokens: tokens,
    costEstimateComplete: true,
    featureCount: 0,
    sources: [{ id: 'source', slug: 'source', title: 'Telemetry', enabled: true }],
  };
  run = {
    id: 'run',
    reason: 'manual',
    startedAt: new Date().toISOString(),
    status: 'running',
    summary: 'Checking current telemetry.',
    connectorId: 'model',
    model: 'Test model',
    thinking: true,
    steps: [],
    tokens,
    estimatedCostUsd: 0,
    written: 0,
    examinedSources: [],
  };
  mockHttp.get.mockImplementation(async (path: string) =>
    path.includes('/runs/') ? { ...run } : { ...status }
  );
  mockHttp.post.mockImplementation(async (path: string) => {
    if (path.endsWith('/_run')) {
      status.runningRunId = run.id;
      status.runs = [run];
    }
    if (path.endsWith('/_cancel')) {
      status.runningRunId = undefined;
      run.status = 'cancelled';
      run.summary = 'Cancelled by user';
    }
    return {};
  });
  mockHttp.put.mockImplementation(async (_path: string, options: { body: string }) => {
    const value: { enabled: boolean; intervalMinutes: number } = JSON.parse(options.body);
    status.enabled = value.enabled;
    status.intervalMinutes = value.intervalMinutes;
    return {};
  });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => client.clear());

const mount = () =>
  render(
    <I18nProvider>
      <EuiProvider>
        <QueryClientProvider client={client}>
          <AgentExplorer />
        </QueryClientProvider>
      </EuiProvider>
    </I18nProvider>
  );

it('starts a run, shows its live state, and lets the user stop it', async () => {
  mount();
  const start = await screen.findByRole('button', { name: 'Run now' });
  await waitFor(() => expect(start).toBeEnabled());
  fireEvent.click(start);
  expect(await screen.findByText('Checking current telemetry.')).toBeInTheDocument();
  fireEvent.click(await screen.findByRole('button', { name: 'Stop' }));
  expect(await screen.findByText('Cancelled by user')).toBeInTheDocument();
  expect(await screen.findByRole('button', { name: 'Run now' })).toBeEnabled();
});

it('saving a frequency while the schedule is off leaves it off', async () => {
  mount();
  const minutes = await screen.findByRole('spinbutton', { name: 'Minutes' });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save frequency' })).toBeEnabled());
  fireEvent.change(minutes, { target: { value: '7' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save frequency' }));
  await waitFor(() => expect(status.intervalMinutes).toBe(7));
  expect(status.enabled).toBe(false);
});

it('keeps Run disabled until an enabled source exists', async () => {
  status.sources = [];
  mount();
  expect(await screen.findByText('Ready to find active problems')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Run now' })).toBeDisabled();
});

it('shows the explorer without a banner when historical usage is incomplete', async () => {
  status.costEstimateComplete = false;
  mount();
  await screen.findByText('Ready to find active problems');
  expect(screen.queryByText('Total cost estimate incomplete')).not.toBeInTheDocument();
});

it('follows updated activity until the user scrolls back and resumes when requested', async () => {
  status.runningRunId = run.id;
  status.runs = [run];
  run.steps = [
    {
      id: 'model',
      kind: 'model',
      name: 'Reasoning 1',
      startedAt: run.startedAt,
      status: 'running',
      durationMs: 0,
      input: '',
      output: '',
    },
  ];
  mount();
  await screen.findByText(run.summary);
  const activity = screen.getByRole('region', { name: 'Live activity' });
  const follow = screen.getByTestId('nightshiftAgentExplorerFollowLive');
  Object.defineProperties(activity, {
    scrollHeight: { value: 1000 },
    clientHeight: { value: 200 },
  });
  const updateActivity = async (output: string) => {
    run.steps = [{ ...run.steps[0], output }];
    await act(async () => {
      await client.invalidateQueries({ queryKey: PROBLEM_AGENT_RUN_QUERY_KEY });
    });
    expect(await screen.findByText(output)).toBeInTheDocument();
  };

  await updateActivity('Checking recent telemetry.');
  expect(activity.scrollTop).toBe(1000);
  expect(follow).toBeChecked();

  fireEvent.scroll(activity, { target: { scrollTop: 200 } });
  expect(follow).not.toBeChecked();
  await updateActivity('Comparing operation outcomes.');
  expect(activity.scrollTop).toBe(200);

  fireEvent.click(follow);
  expect(follow).toBeChecked();
  expect(activity.scrollTop).toBe(1000);
});

it('groups specialist work under its task and preserves the report when model activity is hidden', async () => {
  status.runningRunId = run.id;
  status.runs = [run];
  const step = {
    id: 'call',
    kind: 'tool' as const,
    name: 'delegate_specialist',
    startedAt: run.startedAt,
    status: 'running' as const,
    durationMs: 0,
    input: JSON.stringify({ specialist: 'rule_setter', task: 'Check payment coverage' }),
    output: '',
  };
  run.steps = [
    step,
    {
      ...step,
      id: 'child',
      parentStepId: step.id,
      name: 'monitoring_inventory',
      status: 'completed',
      input: '{}',
      output: '{}',
    },
  ];
  mount();
  expect(await screen.findByText('Detection Agent is waiting for Rule Setter')).toBeVisible();
  const toggle = screen.getByRole('button', { name: 'Rule Setter' });
  expect(toggle).toHaveAttribute('aria-expanded', 'true');
  fireEvent.click(screen.getByTestId('nightshiftAgentExplorerShowModels'));
  expect(screen.getByText('Check payment coverage')).toBeVisible();
  expect(screen.getByTestId('agentExplorerStep')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Inspect tool call' }));
  expect(screen.getByText('Input')).toBeVisible();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Hide details' }));
  expect(screen.queryByText('Input')).not.toBeInTheDocument();
  run.steps = [
    {
      ...step,
      status: 'completed',
      output: JSON.stringify({ report: 'Rule abc covers payments' }),
    },
    run.steps[1],
  ];
  await act(async () => {
    await client.invalidateQueries({ queryKey: PROBLEM_AGENT_RUN_QUERY_KEY });
  });
  await waitFor(() =>
    expect(screen.queryByText('Detection Agent is waiting for Rule Setter')).not.toBeInTheDocument()
  );
  fireEvent.click(toggle);
  expect(await screen.findByText('Rule abc covers payments')).toBeVisible();
});

it.each([
  ['Knowledge indicators (features and standalone queries)', 'knowledge'],
  ['Monitoring rules and their backing queries', 'rules'],
  ['Significant events and their history', 'events'],
])('deletes only the selected %s category after confirmation', async (label, category) => {
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Reset agent outputs' }));
  const confirm = await screen.findByRole('button', { name: 'Delete selected outputs' });
  expect(confirm).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox', { name: label }));
  expect(mockHttp.post).not.toHaveBeenCalled();
  fireEvent.click(confirm);
  await waitFor(() =>
    expect(mockHttp.post).toHaveBeenCalledWith(
      '/internal/significant_events/problem_agent/_reset_outputs',
      { body: JSON.stringify({ outputs: [category], confirmation: 'RESET AGENT OUTPUTS' }) }
    )
  );
});
