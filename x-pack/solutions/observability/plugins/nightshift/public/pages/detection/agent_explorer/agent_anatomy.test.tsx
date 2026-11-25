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
import type { ExplorationAgentAnatomy } from '@kbn/significant-events-plugin/common';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { AgentAnatomy, AgentAnatomyContent } from './agent_anatomy';

const mockHttp = { get: jest.fn(), put: jest.fn(), post: jest.fn() };
jest.mock('../../../hooks/use_kibana', () => ({
  useKibana: () => ({ services: { http: mockHttp } }),
}));
const eventSchema = {
  type: 'object',
  required: ['action'],
  properties: {
    action: { type: 'string', enum: ['index', 'upsert', 'review'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    includeInactive: { type: 'boolean', default: false },
    additionalSetting: { type: 'string', description: 'A newly reported tool setting.' },
  },
} as const;
const child: ExplorationAgentAnatomy = {
  id: 'rules',
  name: 'Rule specialist',
  description: 'Validate native monitoring.',
  model: 'Specialist model',
  connectorId: 'specialist',
  defaultModel: { model: 'Specialist default', connectorId: 'specialist-default' },
  systemPrompt: 'Validate the scoped rule before saving it.',
  subAgents: [],
  tools: [
    {
      name: 'monitoring_rules',
      description: 'Manage native monitors.',
      schema: {
        type: 'object',
        properties: { sourceId: { type: 'string' } },
        required: ['sourceId'],
      },
    },
  ],
};
const root: ExplorationAgentAnatomy = {
  id: 'detection',
  name: 'Detection Agent',
  description: 'Find current problems.',
  model: 'Selected model',
  connectorId: 'selected',
  defaultModel: { model: 'Luna Pro default', connectorId: 'default' },
  systemPrompt: 'Check current outcomes.\nVerify positive recovery.\nSave learned knowledge.',
  tools: [
    {
      name: 'events',
      description: 'Assess current events.',
      schema: { ...eventSchema, required: [...eventSchema.required] },
    },
  ],
  subAgents: [child],
  memory: [
    {
      name: 'Learned lessons',
      scope: 'Space and source',
      storage: 'Native KIs',
      lifetime: 'Across runs',
    },
  ],
};
let client: QueryClient;
beforeEach(() => {
  jest.clearAllMocks();
  client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
    logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
  });
});
afterEach(() => client.clear());
const mount = (content: React.ReactNode) =>
  render(
    <I18nProvider>
      <EuiProvider>
        <QueryClientProvider client={client}>{content}</QueryClientProvider>
      </EuiProvider>
    </I18nProvider>
  );

it('inspects each agent’s own model, prompt, tools and memory without writing configuration', () => {
  mount(<AgentAnatomyContent agent={root} />);
  expect(within(screen.getByRole('tabpanel')).getByText('Selected model')).toBeInTheDocument();
  expect(screen.getByText('Luna Pro default')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('tab', { name: 'System prompt' }));
  fireEvent.change(screen.getByRole('searchbox', { name: 'Find in prompt' }), {
    target: { value: 'recovery' },
  });
  expect(screen.getByText(/2\s+Verify positive recovery/)).toBeInTheDocument();
  expect(screen.queryByText(/3\s+Save learned knowledge/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('tab', { name: 'Memory' }));
  expect(screen.getByText('Across runs')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('tab', { name: /Sub-agents/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Inspect agent' }));
  expect(within(screen.getByRole('tabpanel')).getByText('Specialist model')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('tab', { name: 'System prompt' }));
  expect(screen.getByText(child.systemPrompt)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('tab', { name: /Tools/ }));
  expect(screen.getByRole('heading', { name: 'monitoring_rules' })).toBeInTheDocument();
  expect(screen.queryByText('additionalSetting')).not.toBeInTheDocument();
  expect(mockHttp.put).not.toHaveBeenCalled();
  expect(mockHttp.post).not.toHaveBeenCalled();
});

it('shows tool-specific actions, falsy constraints and additional schema fields', () => {
  mount(<AgentAnatomyContent agent={root} />);
  fireEvent.click(screen.getByRole('tab', { name: /Tools/ }));
  expect(screen.getByRole('heading', { name: 'Identity and lifecycle' })).toBeInTheDocument();
  expect(screen.getAllByText('upsert').length).toBeGreaterThan(0);
  expect(
    within(screen.getByRole('article', { name: 'confidence' })).getByText('0')
  ).toBeInTheDocument();
  expect(
    within(screen.getByRole('article', { name: 'includeInactive' })).getByText('false')
  ).toBeInTheDocument();
  expect(screen.getByText('additionalSetting')).toBeInTheDocument();
  fireEvent.change(screen.getByRole('searchbox', { name: 'Find a tool' }), {
    target: { value: 'absent' },
  });
  expect(screen.getByText('No matching tools')).toBeInTheDocument();
});

it('recovers a failed anatomy fetch and reports an empty sub-agent roster honestly', async () => {
  mockHttp.get
    .mockRejectedValueOnce(new Error('Temporarily unavailable'))
    .mockResolvedValue({ ...root, subAgents: [] });
  mount(<AgentAnatomy onClose={jest.fn()} />);
  expect(await screen.findByText('Temporarily unavailable')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await screen.findByText('Luna Pro default');
  fireEvent.click(screen.getByRole('tab', { name: /Sub-agents/ }));
  expect(screen.getByText('No sub-agents configured')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Rule specialist/ })).not.toBeInTheDocument();
});

it('shows one model card when the effective connector is the configured default', () => {
  mount(
    <AgentAnatomyContent
      agent={{
        ...root,
        connectorId: root.defaultModel.connectorId,
        model: root.defaultModel.model,
      }}
    />
  );
  const panel = within(screen.getByRole('tabpanel'));
  expect(panel.getByText('Default model')).toBeInTheDocument();
  expect(panel.getByText('In use')).toBeInTheDocument();
  expect(panel.queryByText('Effective model')).not.toBeInTheDocument();
});

it('exposes the actual skill instructions in the agent anatomy', () => {
  mount(
    <AgentAnatomyContent
      agent={{
        ...root,
        skills: [
          {
            name: 'manage-events',
            description: 'Maintain incident identity.',
            content: 'Verify recovery using fresh outcomes.',
          },
        ],
      }}
    />
  );
  fireEvent.click(screen.getByRole('tab', { name: /Skills/ }));
  fireEvent.click(screen.getByRole('button', { name: 'manage-events' }));
  expect(screen.getByText('Verify recovery using fresh outcomes.')).toBeVisible();
});
