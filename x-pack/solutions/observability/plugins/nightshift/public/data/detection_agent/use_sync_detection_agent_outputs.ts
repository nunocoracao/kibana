/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@kbn/react-query';
import type { ExplorationStatus } from '@kbn/significant-events-plugin/common';
import { useKibana } from '../../hooks/use_kibana';
import {
  FEATURES_QUERY_KEY,
  SOURCE_FEATURES_QUERY_KEY,
  QUERY_OCCURRENCE_STATS_QUERY_KEY,
  DISCOVERY_QUERIES_QUERY_KEY,
  TOPOLOGY_QUERY_KEY,
  DETECTION_ENTITIES_QUERY_KEY,
  DETECTION_OVERVIEW_QUERY_KEY,
  SIGNIFICANT_EVENTS_LIST_QUERY_KEY,
  SIGNIFICANT_EVENTS_FACETS_QUERY_KEY,
  EVENT_BY_ID_QUERY_KEY,
  EVENT_LIFECYCLE_QUERY_KEY,
  PROBLEM_AGENT_STATUS_QUERY_KEY,
} from '../query_keys';

/** Refreshes native output views when the background detection agent saves progress. */
export const useSyncDetectionAgentOutputs = (enabled: boolean): void => {
  const { http } = useKibana().services;
  const client = useQueryClient();
  const previous = useRef<string>();
  const { data } = useQuery({
    queryKey: PROBLEM_AGENT_STATUS_QUERY_KEY,
    queryFn: ({ signal }) =>
      http.get<ExplorationStatus>('/internal/significant_events/problem_agent', { signal }),
    enabled,
    refetchInterval: enabled ? 5000 : false,
  });
  const run = data?.runs[0];
  const version = data
    ? run
      ? `${run.id}:${run.written}:${run.finishedAt ?? ''}`
      : 'empty'
    : undefined;
  useEffect(() => {
    if (!enabled || !version) return;
    const changed = previous.current !== undefined && previous.current !== version;
    previous.current = version;
    if (!changed) return;
    void Promise.all(
      [
        FEATURES_QUERY_KEY,
        SOURCE_FEATURES_QUERY_KEY,
        QUERY_OCCURRENCE_STATS_QUERY_KEY,
        DISCOVERY_QUERIES_QUERY_KEY,
        TOPOLOGY_QUERY_KEY,
        DETECTION_ENTITIES_QUERY_KEY,
        DETECTION_OVERVIEW_QUERY_KEY,
        SIGNIFICANT_EVENTS_LIST_QUERY_KEY,
        SIGNIFICANT_EVENTS_FACETS_QUERY_KEY,
        EVENT_BY_ID_QUERY_KEY,
        EVENT_LIFECYCLE_QUERY_KEY,
      ].map((queryKey) => client.invalidateQueries({ queryKey }))
    );
  }, [client, enabled, version]);
};
