/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery } from '@kbn/react-query';
import {
  FEATURES_QUERY_KEY,
  DISCOVERY_QUERIES_QUERY_KEY,
  PROBLEM_AGENT_STATUS_QUERY_KEY,
} from '../query_keys';
import { useSyncDetectionAgentOutputs } from './use_sync_detection_agent_outputs';

jest.mock('../../hooks/use_kibana', () => ({
  useKibana: () => ({ services: { http: { get: async () => ({ runs: [] }) } } }),
}));

it('refreshes existing native views when a first background run saves outputs between polls', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let storedFeatures: string[] = [];
  let storedQueries: string[] = [];
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const { result, unmount } = renderHook(
    () => {
      useSyncDetectionAgentOutputs(true);
      const features = useQuery({
        queryKey: [...FEATURES_QUERY_KEY, 'source'],
        queryFn: async () => storedFeatures,
      });
      const queries = useQuery({
        queryKey: [...DISCOVERY_QUERIES_QUERY_KEY, 'source'],
        queryFn: async () => storedQueries,
      });
      return { features: features.data, queries: queries.data };
    },
    { wrapper }
  );
  await waitFor(() => expect(result.current).toEqual({ features: [], queries: [] }));
  storedFeatures = ['observed-service'];
  storedQueries = ['validated-measurement'];
  act(() =>
    client.setQueryData(PROBLEM_AGENT_STATUS_QUERY_KEY, {
      runs: [{ id: 'first-run', written: 2, finishedAt: '2026-11-20T14:30:00Z' }],
    })
  );
  await waitFor(() =>
    expect(result.current).toEqual({ features: storedFeatures, queries: storedQueries })
  );
  unmount();
  client.clear();
});
