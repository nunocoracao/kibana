/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import React, { useMemo } from 'react';
import { BasicPrettyPrinter, Parser } from '@elastic/esql';
import { EuiBadge, EuiCodeBlock, EuiFlexGroup, EuiFlexItem, EuiPanel, EuiText } from '@elastic/eui';
import { DISCOVER_APP_LOCATOR } from '@kbn/deeplinks-analytics';
import type { DiscoverAppLocatorParams } from '@kbn/discover-plugin/common';
import { i18n } from '@kbn/i18n';
import type { SharePluginStart } from '@kbn/share-plugin/public';
import type { SignalEntry } from '@kbn/significant-events-schema';
import { buildDiscoverParams } from '../../../common/discover_helpers';
import { formatTimelineTime } from '../../../common/format_timestamp';
const OPEN_IN_DISCOVER_LABEL = i18n.translate('xpack.nightshift.signalEvidence.openInDiscover', {
  defaultMessage: 'Open in Discover',
});
interface DetectionSignalRowProps {
  signal: SignalEntry;
  share: SharePluginStart;
}

const replaceESQLLimit = (query: string): string => {
  const { root } = Parser.parse(query);
  return BasicPrettyPrinter.print({
    ...root,
    commands: root.commands.filter(
      (command) => command.name !== 'limit' && command.name !== 'keep'
    ),
  });
};

export const SignalEvidenceCard = ({ signal, share }: DetectionSignalRowProps) => {
  const esqlQuery = signal.evidence?.esql_query;
  const normalizedQuery = useMemo(
    () =>
      esqlQuery ? (signal.type === 'query' ? esqlQuery : replaceESQLLimit(esqlQuery)) : undefined,
    [esqlQuery, signal.type]
  );
  const timeRange = useMemo(
    () => signal.evidence?.time_range ?? { from: 'now-1h', to: 'now' },
    [signal.evidence?.time_range]
  );
  const queryHref = useMemo(() => {
    if (!normalizedQuery) {
      return undefined;
    }

    return share.url.locators
      .get<DiscoverAppLocatorParams>(DISCOVER_APP_LOCATOR)
      ?.getRedirectUrl(buildDiscoverParams(normalizedQuery, timeRange));
  }, [normalizedQuery, share, timeRange]);

  return (
    <EuiPanel hasBorder hasShadow={false}>
      <EuiFlexGroup direction="column" gutterSize="s">
        <EuiFlexItem grow={false}>
          <EuiBadge
            color={
              signal.verdict === 'confirms'
                ? 'danger'
                : signal.verdict === 'refutes'
                ? 'success'
                : 'hollow'
            }
          >
            {signal.verdict === 'confirms'
              ? i18n.translate('xpack.nightshift.signalEvidence.confirms', {
                  defaultMessage: 'Confirms problem',
                })
              : signal.verdict === 'refutes'
              ? i18n.translate('xpack.nightshift.signalEvidence.refutes', {
                  defaultMessage: 'Supports recovery',
                })
              : signal.verdict === 'not_checked'
              ? i18n.translate('xpack.nightshift.signalEvidence.notChecked', {
                  defaultMessage: 'Not checked',
                })
              : signal.verdict === 'off_topic'
              ? i18n.translate('xpack.nightshift.signalEvidence.offTopic', {
                  defaultMessage: 'Unrelated evidence',
                })
              : i18n.translate('xpack.nightshift.signalEvidence.inconclusive', {
                  defaultMessage: 'Inconclusive',
                })}
          </EuiBadge>
        </EuiFlexItem>
        {(signal.metadata?.rule_name || signal.collected_at) && (
          <EuiFlexItem grow={false}>
            {signal.metadata?.rule_name && (
              <EuiText size="s">
                <strong>{signal.metadata.rule_name}</strong>
              </EuiText>
            )}
            {signal.collected_at && (
              <EuiText size="xs" color="subdued">
                {formatTimelineTime(signal.collected_at)}
              </EuiText>
            )}
          </EuiFlexItem>
        )}

        {signal.description && (
          <EuiFlexItem grow={false}>
            <EuiText size="xs" color="subdued">
              {signal.description}
            </EuiText>
          </EuiFlexItem>
        )}

        {normalizedQuery && (
          <EuiFlexItem grow={false}>
            <EuiCodeBlock language="esql" fontSize="s" paddingSize="s" isCopyable>
              {normalizedQuery}
            </EuiCodeBlock>
          </EuiFlexItem>
        )}

        {queryHref && (
          <EuiFlexItem grow={false}>
            <EuiBadge
              color="hollow"
              iconType="discoverApp"
              href={queryHref}
              target="_blank"
              data-test-subj="nightshiftSignificantEventCanvasOpenInDiscoverLink"
            >
              {OPEN_IN_DISCOVER_LABEL}
            </EuiBadge>
          </EuiFlexItem>
        )}
      </EuiFlexGroup>
    </EuiPanel>
  );
};
