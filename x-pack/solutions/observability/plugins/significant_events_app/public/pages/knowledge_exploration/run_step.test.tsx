/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ExplorationStep } from '@kbn/significant-events-plugin/common';
import { RunStep } from './run_step';
import { getStepDescription } from './step_summary';

const step: ExplorationStep = {
  id: 'query',
  kind: 'tool',
  name: 'source_esql',
  status: 'completed',
  startedAt: '2026-10-14T21:00:00Z',
  durationMs: 0,
  input: JSON.stringify({
    template: 'relationships',
    sourceIds: ['source-id'],
    serviceNames: ['search'],
    serviceNamespace: 'undertow',
    lookbackMinutes: 1440,
  }),
  output: JSON.stringify({ results: [{ rows: [], candidates: [] }], failed: false }),
};

describe('Agent Explorer run activity', () => {
  it('keeps raw tool calls inspectable and pauses following when opened', () => {
    const onInspect = jest.fn();
    const { container } = render(<RunStep step={step} onInspect={onInspect} />);
    expect(screen.getByText('Investigate dependencies')).toBeInTheDocument();
    expect(container.textContent).not.toContain('source-id');
    fireEvent.click(screen.getByRole('button', { name: 'Inspect tool call' }));
    expect(onInspect).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Input')).toBeInTheDocument();
    expect(screen.getByText('Result')).toBeInTheDocument();
    expect(container.textContent).toContain('source-id');
    fireEvent.click(screen.getByRole('button', { name: 'Hide details' }));
    expect(screen.queryByText('Input')).not.toBeInTheDocument();
  });

  it('shows returned model commentary with context instead of inventing thinking text', () => {
    render(
      <RunStep
        step={{
          ...step,
          kind: 'model',
          name: 'Reasoning 3',
          output: 'I will inspect structured dependency fields next.',
        }}
        previousTool={step}
        onInspect={jest.fn()}
      />
    );
    expect(
      screen.getByText('I will inspect structured dependency fields next.')
    ).toBeInTheDocument();
    expect(screen.getByText('After: Investigate dependencies')).toBeInTheDocument();
  });

  it('describes query scope without treating missing candidate hints as no dependencies', () => {
    const description = getStepDescription(step);
    expect(description.scope).toBe('search · undertow · 24h of data');
    expect(description.result).toBe('0 rows');
    expect(description.status).toBe('completed');
  });

  it('surfaces partial query failures when another source succeeded', () => {
    const description = getStepDescription({
      ...step,
      output: JSON.stringify({
        results: [{ rows: [{}] }, { error: 'Unknown column' }],
        failed: true,
      }),
    });
    expect(description.status).toBe('partial');
    expect(description.error).toBe('Unknown column');
  });

  it('shows accepted KI titles from featuresJson and the real rejection reason', () => {
    const description = getStepDescription({
      ...step,
      name: 'knowledge_indicators',
      input: JSON.stringify({
        action: 'upsert',
        features: [],
        featuresJson: JSON.stringify([{ id: 'dependency', title: 'search → availability' }]),
      }),
      output: JSON.stringify({
        saved: [{ id: 'dependency' }],
        rejected: [{ id: 'collision', reason: 'ID collision' }],
        unchanged: [],
      }),
    });
    expect(description.items).toEqual(['search → availability']);
    expect(description.status).toBe('partial');
    expect(description.error).toBe('ID collision');
  });

  it('describes monitoring and event actions separately', () => {
    expect(
      getStepDescription({
        ...step,
        name: 'monitoring_rules',
        input: JSON.stringify({ action: 'baseline', title: 'Search errors' }),
        output: '{}',
      }).title
    ).toBe('Measure a monitoring baseline');
    expect(
      getStepDescription({
        ...step,
        name: 'events',
        input: JSON.stringify({ action: 'upsert', status: 'inactive' }),
        output: '{"status":"inactive"}',
      }).title
    ).toBe('Record inactive event assessment');
  });

  it('handles malformed historical payloads without crashing the inspector', () => {
    expect(() =>
      getStepDescription({ ...step, input: 'not JSON', output: 'truncated' })
    ).not.toThrow();
  });

  it('shows infrastructure counts and observed resource details before expanding', () => {
    const { container } = render(
      <RunStep
        step={{
          ...step,
          input: JSON.stringify({ template: 'infrastructure', sourceIds: ['source-id'] }),
          output: JSON.stringify({
            results: [
              {
                totalGroups: 12,
                records: [{ 'host.name': 'worker-01', observedService: { name: 'search' } }],
                hasMore: true,
              },
            ],
          }),
        }}
        onInspect={jest.fn()}
      />
    );
    expect(screen.getByText('12 resource groups · 1 shown · more available')).toBeInTheDocument();
    expect(container.textContent).toContain('host.name=worker-01');
    expect(screen.getByRole('button', { name: 'Inspect tool call' })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
    expect(container.textContent).not.toContain('source-id');
  });

  it('previews query text and returned values while retaining the full tool inspector', () => {
    const pipeline = '| WHERE service.name == "search" | STATS requests=COUNT(*)';
    render(
      <RunStep
        step={{
          ...step,
          input: JSON.stringify({ template: 'custom', pipeline }),
          output: JSON.stringify({ results: [{ columns: [{ name: 'requests' }], rows: [[42]] }] }),
        }}
        onInspect={jest.fn()}
      />
    );
    expect(screen.getByText(pipeline)).toBeInTheDocument();
    expect(screen.getByText('requests=42')).toBeInTheDocument();
    expect(screen.queryByText('Input')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Inspect tool call' }));
    expect(screen.getByText('Input')).toBeInTheDocument();
    expect(screen.getByText('Result')).toBeInTheDocument();
  });

  it('distinguishes shared-trace results and summary-only resource responses from zero rows', () => {
    expect(
      getStepDescription({
        ...step,
        input: '{"template":"trace_links"}',
        output: '{"results":[{"links":[{},{}]}]}',
      }).result
    ).toBe('2 shared-trace groups');
    const description = getStepDescription({
      ...step,
      input: '{"template":"infrastructure"}',
      output: '{"results":[{"totalGroups":20,"needsDetails":true}]}',
    });
    expect(description.result).toBe('20 resource groups · 0 shown');
    expect(description.note).toContain('row details are not included');
  });
});
