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
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ExplorationStatus, ExplorationRun } from '@kbn/significant-events-plugin/common';
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

it('marks totals as incomplete when a provider request has unreported usage', async () => {
  status.costEstimateComplete = false;
  mount();
  expect(await screen.findByText('Total cost estimate incomplete')).toBeInTheDocument();
  expect(
    screen.getByText(/cumulative total includes runs with missing usage or pricing/)
  ).toBeInTheDocument();
});
