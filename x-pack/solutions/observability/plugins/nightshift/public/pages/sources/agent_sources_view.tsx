/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { getEbtProps } from '@kbn/ebt-click';
import React, { lazy, Suspense, useState } from 'react';
import {
  EuiButton,
  EuiButtonEmpty,
  EuiInMemoryTable,
  EuiLoadingSpinner,
  EuiSpacer,
  EuiSwitch,
  EuiText,
  EuiTitle,
} from '@elastic/eui';
import { i18n } from '@kbn/i18n';
import { getNightshiftCapabilities, type NightshiftSource } from '@kbn/nightshift-shared';
import { useHistory, useParams } from 'react-router-dom';
import { useKibana } from '../../hooks/use_kibana';
import { useFetchSources } from '../../data/sources/use_fetch_sources';
import { useSourcesApi } from '../../data/sources/use_sources_api';
import { ConfirmSourceActionModal } from '../../components/entities/source/confirm_source_action_modal';

const SourceFlyout = lazy(() =>
  import('../../components/entities/source/source_flyout/source_flyout').then(
    ({ SourceFlyout: Flyout }) => ({ default: Flyout })
  )
);
const labels = {
  title: i18n.translate('xpack.nightshift.agentSources.title', { defaultMessage: 'Sources' }),
  description: i18n.translate('xpack.nightshift.agentSources.description', {
    defaultMessage:
      'Choose the telemetry the Problem Agent can read. Adding a source does not start a run. Use Agent Explorer to run or schedule the agent.',
  }),
  create: i18n.translate('xpack.nightshift.agentSources.create', { defaultMessage: 'Add source' }),
  name: i18n.translate('xpack.nightshift.agentSources.name', { defaultMessage: 'Name' }),
  enabled: i18n.translate('xpack.nightshift.agentSources.enabled', { defaultMessage: 'Enabled' }),
  query: i18n.translate('xpack.nightshift.agentSources.query', { defaultMessage: 'Query' }),
  remove: i18n.translate('xpack.nightshift.agentSources.remove', { defaultMessage: 'Delete' }),
  retry: i18n.translate('xpack.nightshift.agentSources.retry', { defaultMessage: 'Retry' }),
};

export function AgentSourcesView() {
  const { application } = useKibana().services;
  const { canManageAndConfigure } = getNightshiftCapabilities(application.capabilities.nightshift);
  const { data: sources = [], isLoading, isError, refetch } = useFetchSources();
  const { setSourceEnabled, deleteSource } = useSourcesApi();
  const history = useHistory();
  const { sourceId } = useParams<{ sourceId?: string }>();
  const source = sources.find(({ id }) => id === sourceId);
  const [pendingDelete, setPendingDelete] = useState<NightshiftSource>();
  return (
    <>
      <EuiTitle>
        <h2>{labels.title}</h2>
      </EuiTitle>
      <EuiText size="s">
        <p>{labels.description}</p>
      </EuiText>
      <EuiSpacer />
      {canManageAndConfigure && (
        <EuiButton
          {...getEbtProps({ action: 'agentSources1', element: 'problemAgent' })}
          onClick={() => history.push('/sources/new')}
          data-test-subj="nightshiftAddAgentSource"
        >
          {labels.create}
        </EuiButton>
      )}
      <EuiSpacer />
      {isError && (
        <EuiButton
          {...getEbtProps({ action: 'agentSources2', element: 'problemAgent' })}
          onClick={() => void refetch()}
          data-test-subj="nightshiftRetryAgentSources"
        >
          {labels.retry}
        </EuiButton>
      )}
      <EuiInMemoryTable<NightshiftSource>
        tableCaption={labels.title}
        items={sources}
        loading={isLoading}
        pagination
        sorting
        search={{ box: { incremental: true } }}
        columns={[
          {
            field: 'title',
            name: labels.name,
            sortable: true,
            render: (title: string, row: NightshiftSource) => (
              <EuiButtonEmpty
                {...getEbtProps({ action: 'agentSources3', element: 'problemAgent' })}
                flush="left"
                onClick={() => history.push(`/sources/${row.id}`)}
                data-test-subj="nightshiftOpenAgentSource"
              >
                {title}
              </EuiButtonEmpty>
            ),
          },
          { field: 'esql', name: labels.query, truncateText: true },
          {
            field: 'enabled',
            name: labels.enabled,
            render: (enabled: boolean, row: NightshiftSource) => (
              <EuiSwitch
                id={`agent-source-enabled-${row.id}`}
                label={labels.enabled}
                showLabel={false}
                checked={enabled}
                disabled={!canManageAndConfigure || setSourceEnabled.isLoading}
                onChange={(event) =>
                  setSourceEnabled.mutate({ sourceId: row.id, enabled: event.target.checked })
                }
              />
            ),
          },
          {
            name: labels.remove,
            render: (row: NightshiftSource) =>
              canManageAndConfigure && (
                <EuiButtonEmpty
                  {...getEbtProps({ action: 'agentSources4', element: 'problemAgent' })}
                  color="danger"
                  onClick={() => setPendingDelete(row)}
                  data-test-subj="nightshiftDeleteAgentSource"
                >
                  {labels.remove}
                </EuiButtonEmpty>
              ),
          },
        ]}
      />
      {((sourceId === 'new' && canManageAndConfigure) || source) && (
        <Suspense fallback={<EuiLoadingSpinner />}>
          <SourceFlyout
            key={source?.id ?? 'new'}
            source={source}
            readOnly={!canManageAndConfigure}
            onClose={() => history.push('/sources')}
          />
        </Suspense>
      )}
      {pendingDelete && (
        <ConfirmSourceActionModal
          action="delete"
          source={pendingDelete}
          isLoading={deleteSource.isLoading}
          onCancel={() => setPendingDelete(undefined)}
          onConfirm={() =>
            deleteSource.mutate(pendingDelete, { onSettled: () => setPendingDelete(undefined) })
          }
        />
      )}
    </>
  );
}
