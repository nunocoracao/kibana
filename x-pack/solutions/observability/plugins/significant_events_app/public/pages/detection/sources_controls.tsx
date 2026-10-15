/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */
import React, { useState } from 'react';
import {
  EuiBadge,
  EuiButton,
  EuiButtonEmpty,
  EuiFieldSearch,
  EuiFlexGroup,
  EuiFlexItem,
  EuiLoadingSpinner,
  EuiPanel,
  EuiSpacer,
  EuiText,
} from '@elastic/eui';
import { i18n } from '@kbn/i18n';
import { getNightshiftCapabilities, type NightshiftSource } from '@kbn/nightshift-shared';
import { useFetchSources } from '../../hooks/use_fetch_sources';
import { useKibana } from '../../hooks/use_kibana';
import { SourceFlyout } from '../significant_events/components/sources_view/source_flyout/source_flyout';
import { useEvidence } from '../../components/evidence_chain/evidence_context';
import { journey } from './journey_translations';

const createLabel = i18n.translate('xpack.significantEventsApp.detection.sources.create', {
  defaultMessage: 'Create source',
});
const searchLabel = i18n.translate('xpack.significantEventsApp.detection.sources.search', {
  defaultMessage: 'Find a source…',
});
const enabledLabel = i18n.translate('xpack.significantEventsApp.detection.sources.enabled', {
  defaultMessage: 'Enabled',
});
const disabledLabel = i18n.translate('xpack.significantEventsApp.detection.sources.disabled', {
  defaultMessage: 'Disabled',
});

export const SourcesControls = ({
  selectedSourceId,
  onCloseSource,
}: {
  selectedSourceId?: string;
  onCloseSource: () => void;
}): React.ReactElement => {
  const { core } = useKibana();
  const sources = useFetchSources();
  const { onNavigate } = useEvidence();
  const [search, setSearch] = useState('');
  const [flyout, setFlyout] = useState<{ source?: NightshiftSource }>();
  const selectedSource = (sources.data ?? []).find((source) => source.id === selectedSourceId);
  const canManage = getNightshiftCapabilities(core.application.capabilities.nightshift).canManage;
  return (
    <>
      <EuiFlexGroup alignItems="center">
        <EuiFlexItem>
          <EuiFieldSearch
            data-test-subj="significantEventsAppSourcesControlsFieldSearch"
            aria-label={searchLabel}
            placeholder={searchLabel}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            isClearable
          />
        </EuiFlexItem>
        {canManage && (
          <EuiFlexItem grow={false}>
            <EuiButton
              data-test-subj="significantEventsAppSourcesControlsButton"
              iconType="plusInCircle"
              onClick={() => setFlyout({})}
            >
              {createLabel}
            </EuiButton>
          </EuiFlexItem>
        )}
      </EuiFlexGroup>
      <EuiSpacer size="m" />
      {sources.isLoading && <EuiLoadingSpinner />}
      {(sources.data ?? [])
        .filter((source) =>
          `${source.title} ${source.description} ${source.tags.join(' ')}`
            .toLowerCase()
            .includes(search.toLowerCase())
        )
        .map((source) => (
          <React.Fragment key={source.id}>
            <EuiPanel hasBorder hasShadow={false}>
              <EuiFlexGroup alignItems="center">
                <EuiFlexItem>
                  <EuiButtonEmpty
                    data-test-subj="significantEventsAppSourcesControlsButton"
                    flush="left"
                    onClick={() => setFlyout({ source })}
                  >
                    {source.title}
                  </EuiButtonEmpty>
                  <EuiText size="s" color="subdued">
                    <p>{source.description}</p>
                  </EuiText>
                </EuiFlexItem>
                <EuiFlexItem grow={false}>
                  <EuiBadge color={source.enabled ? 'success' : 'hollow'}>
                    {source.enabled ? enabledLabel : disabledLabel}
                  </EuiBadge>
                </EuiFlexItem>
                <EuiFlexItem grow={false}>
                  <EuiButtonEmpty
                    data-test-subj="significantEventsAppSourcesControlsButton"
                    iconType="graphApp"
                    size="s"
                    onClick={() =>
                      onNavigate?.({ kind: 'source', id: source.id, sourceId: source.id })
                    }
                  >
                    {journey.source}
                  </EuiButtonEmpty>
                </EuiFlexItem>
              </EuiFlexGroup>
            </EuiPanel>
            <EuiSpacer size="s" />
          </React.Fragment>
        ))}
      {selectedSource && !flyout && (
        <SourceFlyout source={selectedSource} readOnly={!canManage} onClose={onCloseSource} />
      )}
      {flyout && (
        <SourceFlyout
          source={flyout.source}
          readOnly={!canManage}
          onClose={() => setFlyout(undefined)}
        />
      )}
    </>
  );
};
