/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import React, { useState } from 'react';
import { EuiBadge, EuiLink, EuiFlexGroup, EuiFlexItem, EuiSpacer, EuiText } from '@elastic/eui';
import { i18n } from '@kbn/i18n';
import type { SignificantEvent } from '@kbn/significant-events-schema';
import type { Feature } from '@kbn/significant-events-schema';
import { DISCOVER_APP_LOCATOR } from '@kbn/deeplinks-analytics';
import type { DiscoverAppLocatorParams } from '@kbn/discover-plugin/common';
import { buildDiscoverParams } from '../../../common/discover_helpers';
import { useKibana } from '../../../hooks/use_kibana';
import { useImpactedServices } from '../../../data/significant_events/use_impacted_services';
import { EntityChip } from '../entity/entity_chip';
import { EntityFlyout } from '../entity/entity_flyout';
import { SignalEvidenceCard } from './signal_evidence_card';

export const EventQueryEvidence = ({ event }: { event: SignificantEvent }) => {
  const { share } = useKibana().services;
  const { services } = useImpactedServices(event);
  const [selected, setSelected] = useState<Feature>();
  const signals = (event.signals ?? []).filter((signal) => signal.type === 'query');
  return (
    <>
      {services.length > 0 && (
        <>
          <EuiText size="s">
            <h4>
              {i18n.translate('xpack.nightshift.eventEvidence.affected', {
                defaultMessage: 'Affected entities',
              })}
            </h4>
          </EuiText>
          <EuiSpacer size="s" />
          <EuiFlexGroup gutterSize="s" wrap responsive={false}>
            {services.map((entity) => (
              <EuiFlexItem grow={false} key={entity.key}>
                <EntityChip
                  label={`${entity.feature.properties.service_namespace ?? ''}/${entity.name}`}
                  onClick={() => setSelected(entity.feature)}
                  size="compact"
                  testSubj="nightshiftEventAffectedEntity"
                  ebt={{ action: 'viewEntity', element: 'eventEvidence' }}
                />
              </EuiFlexItem>
            ))}
          </EuiFlexGroup>
          <EuiSpacer />
        </>
      )}
      {event.symptom_hypothesis && (
        <>
          <EuiText size="s">
            <h4>
              {i18n.translate('xpack.nightshift.eventEvidence.mechanism', {
                defaultMessage: 'Observed mechanism',
              })}
            </h4>
            <p>{event.symptom_hypothesis}</p>
          </EuiText>
          <EuiSpacer size="s" />
        </>
      )}
      {!!event.causal_features?.length && (
        <>
          <EuiFlexGroup gutterSize="s" wrap>
            {event.causal_features.map((feature) => (
              <EuiFlexItem grow={false} key={feature.feature_id}>
                <EuiBadge>{feature.name}</EuiBadge>
              </EuiFlexItem>
            ))}
          </EuiFlexGroup>
          <EuiSpacer />
        </>
      )}
      <EuiFlexGroup direction="column" gutterSize="s">
        {signals.map((signal, index) => (
          <EuiFlexItem key={`${signal.source_id}-${index}`}>
            <SignalEvidenceCard signal={signal} share={share} />
          </EuiFlexItem>
        ))}
      </EuiFlexGroup>
      {!!event.monitoring_references?.length && (
        <EuiText size="s">
          <h4>
            {i18n.translate('xpack.nightshift.eventEvidence.monitors', {
              defaultMessage: 'Monitoring references',
            })}
          </h4>
          <ul>
            {event.monitoring_references.map((ref) => (
              <li key={JSON.stringify(ref)}>
                {ref.sourceId} · {ref.queryId}
                {ref.ruleId && ref.ruleId !== ref.queryId && ` · ${ref.ruleId}`}
              </li>
            ))}
          </ul>
        </EuiText>
      )}
      {!!event.firing_references?.length && (
        <EuiText size="s">
          <h4>
            {i18n.translate('xpack.nightshift.eventEvidence.firings', {
              defaultMessage: 'Observed rule signals and alerts',
            })}
          </h4>
          <ul>
            {event.firing_references.map((ref) => (
              <li key={JSON.stringify([ref.index, ref.documentId])}>
                <EuiLink
                  href={share.url.locators
                    .get<DiscoverAppLocatorParams>(DISCOVER_APP_LOCATOR)
                    ?.getRedirectUrl(
                      buildDiscoverParams(
                        `FROM ${JSON.stringify(
                          ref.index
                        )} METADATA _id | WHERE _id == ${JSON.stringify(ref.documentId)}`,
                        { from: ref.timestamp, to: 'now' }
                      )
                    )}
                >
                  {ref.ruleName} · {ref.timestamp}
                </EuiLink>
              </li>
            ))}
          </ul>
        </EuiText>
      )}
      {selected && <EntityFlyout feature={selected} onClose={() => setSelected(undefined)} />}
    </>
  );
};
