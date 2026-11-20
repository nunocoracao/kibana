/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import React, { useMemo } from 'react';
import { EuiBadge, EuiFlexGroup, EuiFlexItem } from '@elastic/eui';
import { i18n } from '@kbn/i18n';
import type { SharePluginStart } from '@kbn/share-plugin/public';
import type { SignificantEvent } from '@kbn/significant-events-schema';
import { FlyoutSectionTitle } from '../../components/ui/flyout_section_title';
import { TruncatableSummary } from '../../components/ui/truncatable_summary';
import { SeverityBadge } from '../../components/ui/severity_badge';

const DESCRIPTION_TITLE = i18n.translate(
  'xpack.nightshift.significantEventCanvas.descriptionTitle',
  { defaultMessage: 'Description' }
);

const CAUSAL_FEATURES_TITLE = i18n.translate(
  'xpack.nightshift.significantEventCanvas.causalFeaturesTitle',
  { defaultMessage: 'Causal features' }
);

const SIGNALS_TITLE = i18n.translate('xpack.nightshift.significantEventCanvas.signalsTitle', {
  defaultMessage: 'Signals',
});

import { SignalEvidenceCard } from '../../components/entities/significant_event/signal_evidence_card';

export const SignificantEventCanvas = ({
  event,
  share,
}: {
  event: SignificantEvent;
  share: SharePluginStart;
}): React.ReactElement => {
  const detectionSignals = useMemo(() => event.signals ?? [], [event.signals]);

  return (
    <EuiFlexGroup direction="column" gutterSize="m">
      <EuiFlexItem grow={false}>
        <SeverityBadge severity={event.severity} />
      </EuiFlexItem>

      <EuiFlexItem grow={false}>
        <EuiFlexGroup direction="column" gutterSize="s">
          <EuiFlexItem grow={false}>
            <FlyoutSectionTitle>{DESCRIPTION_TITLE}</FlyoutSectionTitle>
          </EuiFlexItem>
          <EuiFlexItem grow={false}>
            <TruncatableSummary summary={event.summary} />
          </EuiFlexItem>
        </EuiFlexGroup>
      </EuiFlexItem>

      {event.causal_features && event.causal_features.length > 0 && (
        <EuiFlexItem grow={false}>
          <EuiFlexGroup direction="column" gutterSize="s">
            <EuiFlexItem grow={false}>
              <FlyoutSectionTitle>{CAUSAL_FEATURES_TITLE}</FlyoutSectionTitle>
            </EuiFlexItem>
            <EuiFlexItem grow={false}>
              <EuiFlexGroup gutterSize="xs" wrap responsive={false}>
                {event.causal_features.map((feature) => (
                  <EuiFlexItem grow={false} key={feature.feature_id}>
                    <EuiBadge>{feature.name}</EuiBadge>
                  </EuiFlexItem>
                ))}
              </EuiFlexGroup>
            </EuiFlexItem>
          </EuiFlexGroup>
        </EuiFlexItem>
      )}

      {detectionSignals.length > 0 && (
        <EuiFlexItem grow={false}>
          <EuiFlexGroup direction="column" gutterSize="s">
            <EuiFlexItem grow={false}>
              <EuiFlexGroup gutterSize="s" alignItems="center" responsive={false}>
                <EuiFlexItem grow={false}>
                  <FlyoutSectionTitle>{SIGNALS_TITLE}</FlyoutSectionTitle>
                </EuiFlexItem>
                <EuiFlexItem grow={false}>
                  <EuiBadge color="hollow">{detectionSignals.length}</EuiBadge>
                </EuiFlexItem>
              </EuiFlexGroup>
            </EuiFlexItem>
            {detectionSignals.map((signal, index) => (
              <EuiFlexItem grow={false} key={`${signal.source_id}-${index}`}>
                <SignalEvidenceCard signal={signal} share={share} />
              </EuiFlexItem>
            ))}
          </EuiFlexGroup>
        </EuiFlexItem>
      )}
    </EuiFlexGroup>
  );
};
