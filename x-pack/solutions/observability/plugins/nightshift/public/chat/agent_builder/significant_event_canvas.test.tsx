/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { I18nProvider } from '@kbn/i18n-react';
import type { SharePluginStart } from '@kbn/share-plugin/public';
import type { SignalEntry, SignificantEvent } from '@kbn/significant-events-schema';
import { SignificantEventCanvas } from './significant_event_canvas';

const DISCOVER_HREF = '/app/discover#significant-event-query';
const mockGetRedirectUrl = jest.fn(() => DISCOVER_HREF);

const detectionSignal: SignalEntry = {
  type: 'detection',
  source_id: 'logs.checkout',
  description: 'Found: connection refused. Impact: checkout blocked.',
  verdict: 'confirms',
  collected_at: '2026-06-11T15:10:00.000Z',
  evidence: {
    esql_query:
      'FROM logs.checkout | WHERE @timestamp >= "2026-06-11T15:03:00Z" AND @timestamp <= "2026-06-11T15:10:00.000Z"',
    result: 'found',
    time_range: {
      from: '2026-06-11T15:03:00.000Z',
      to: '2026-06-11T15:10:00.000Z',
    },
  },
  metadata: {
    rule_name: 'Connection refused in checkout',
    rule_uuid: 'rule-1',
    detection_id: 'det-1',
    change_point_type: 'spike',
    p_value: 0.001,
  },
};

const event: SignificantEvent = {
  '@timestamp': '2026-06-11T15:03:00.000Z',
  event_id: 'checkout-outage',
  status: 'active',
  source_ids: ['logs.checkout'],
  title: 'Checkout outage',
  summary: 'Payment processing is failing.',
  severity: 'high',
  confidence: 0.9,
  signals: [detectionSignal],
  causal_features: [],
  blast_radius: [],
};

describe('SignificantEventCanvas', () => {
  it.each([
    detectionSignal,
    {
      type: 'query',
      source_id: 'logs.checkout',
      metadata: { rule_name: 'Verified checkout failures' },
      description: 'Actual failed operations',
      verdict: 'confirms',
      collected_at: '2026-06-11T15:10:00.000Z',
      evidence: {
        esql_query:
          'FROM $.logs | WHERE @timestamp >= TO_DATETIME("2026-06-11T15:03:00Z") | STATS failures=COUNT(*) | LIMIT 5',
        result: 'found',
        time_range: { from: '2026-06-11T15:03:00.000Z', to: '2026-06-11T15:10:00.000Z' },
      },
    } satisfies SignalEntry,
  ])('renders genuine signal evidence and its fixed-window Discover link', (signal) => {
    const share = {
      url: {
        locators: {
          get: () => ({ getRedirectUrl: mockGetRedirectUrl }),
        },
      },
    } as unknown as SharePluginStart;

    render(
      <I18nProvider>
        <SignificantEventCanvas event={{ ...event, signals: [signal] }} share={share} />
      </I18nProvider>
    );

    expect(
      screen.getByText(signal.type === 'query' ? /FROM \$.logs/ : /FROM logs.checkout/)
    ).toBeInTheDocument();
    if (signal.type === 'query')
      expect(mockGetRedirectUrl).toHaveBeenLastCalledWith(
        expect.objectContaining({
          query: { esql: signal.evidence.esql_query },
          timeRange: signal.evidence.time_range,
        })
      );
    expect(
      screen.getByTestId('nightshiftSignificantEventCanvasOpenInDiscoverLink')
    ).toHaveAttribute('href', DISCOVER_HREF);
  });
});
