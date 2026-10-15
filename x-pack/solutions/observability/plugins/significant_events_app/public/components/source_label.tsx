/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */
import React from 'react';
import { useFetchSources } from '../hooks/use_fetch_sources';

export const SourceLabel = ({ sourceId }: { sourceId: string }): React.ReactElement => {
  const sources = useFetchSources({ showErrorToast: false });
  return <>{sources.data?.find((source) => source.id === sourceId)?.title ?? sourceId}</>;
};
