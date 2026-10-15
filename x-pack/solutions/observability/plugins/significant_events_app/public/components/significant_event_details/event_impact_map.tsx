/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import React, { useMemo } from 'react';
import { EuiButtonEmpty, EuiIcon, EuiPanel, EuiSpacer, EuiText } from '@elastic/eui';
import { i18n } from '@kbn/i18n';
import type { SignificantEvent } from '@kbn/significant-events-schema';
import { DetectionTopology } from '../../pages/detection/topology';
import { buildDetectionModel } from '../../pages/detection/model';
import { useEvidence } from '../evidence_chain/evidence_context';

export const EventImpactMap = ({
  event,
}: {
  event: SignificantEvent;
}): React.ReactElement | null => {
  const { data, href, onNavigate } = useEvidence();
  const impact = useMemo(() => {
    const model = buildDetectionModel(data.features, data.queries, data.detections, data.events);
    const references = event.blast_radius ?? [];
    const affected = new Set<string>();
    for (const edge of model.relationships) {
      if (
        (edge.features ?? []).some((f) =>
          references.some((ref) => ref.feature_id === f.id && ref.source_id === f.source_id)
        )
      ) {
        affected.add(edge.source);
        affected.add(edge.target);
      }
    }
    for (const entity of model.entities) {
      if (
        (entity.features ?? []).some((f) =>
          references.some(
            (ref) =>
              ref.type === 'entity' && ref.feature_id === f.id && ref.source_id === f.source_id
          )
        )
      )
        affected.add(entity.id);
    }
    const edges = model.relationships.filter(
      (edge) => affected.has(edge.source) || affected.has(edge.target)
    );
    const visible = new Set([...affected, ...edges.flatMap((edge) => [edge.source, edge.target])]);
    return {
      entities: model.entities.filter((entity) => visible.has(entity.id)),
      relationships: edges,
      unresolvedRelationships: 0,
      unassignedRules: 0,
    };
  }, [data, event]);
  if (!event.blast_radius?.length) return null;
  return (
    <section data-test-subj="significantEventImpactMap">
      {impact.entities.length > 0 && (
        <DetectionTopology
          model={impact}
          height={260}
          showLegend={false}
          title={i18n.translate('xpack.significantEventsApp.eventImpact.title', {
            defaultMessage: 'Affected services & dependencies',
          })}
          description={i18n.translate('xpack.significantEventsApp.eventImpact.hint', {
            defaultMessage:
              'The affected dependency path, with its learned upstream and downstream connections.',
          })}
          onSelect={(id) => {
            const target = { kind: 'service' as const, id };
            if (onNavigate) onNavigate(target);
            else window.location.assign(href(target));
          }}
          onInspectFeature={(feature) => {
            const target = {
              kind: 'feature' as const,
              id: feature.id,
              sourceId: feature.source_id,
            };
            if (onNavigate) onNavigate(target);
            else window.location.assign(href(target));
          }}
        />
      )}
      <EuiSpacer size="s" />
      {event.blast_radius.map((entry, index) => {
        const target = {
          kind: 'feature' as const,
          id: entry.feature_id,
          sourceId: entry.source_id,
        };
        return (
          <EuiPanel
            key={`${entry.source_id}:${entry.feature_id}:${index}`}
            hasShadow={false}
            color="subdued"
            paddingSize="s"
          >
            <EuiButtonEmpty
              size="xs"
              iconType={
                entry.type === 'dependency'
                  ? 'graphApp'
                  : entry.type === 'entity'
                  ? 'apps'
                  : 'boxesVertical'
              }
              flush="left"
              href={href(target)}
              onClick={
                onNavigate
                  ? (e: React.MouseEvent<HTMLAnchorElement>) => {
                      e.preventDefault();
                      onNavigate(target);
                    }
                  : undefined
              }
              data-test-subj="significantEventImpactKnowledge"
            >
              {entry.type === 'dependency' ? (
                <>
                  {entry.source} <EuiIcon type="sortRight" size="s" aria-hidden={true} />{' '}
                  {entry.target}
                </>
              ) : entry.type === 'entity' ? (
                entry.name
              ) : (
                entry.title || entry.feature_id
              )}
            </EuiButtonEmpty>
            <EuiText size="xs" color="subdued">
              {entry.type === 'dependency' && entry.protocol ? `${entry.protocol} · ` : ''}
              {entry.source_id}
            </EuiText>
          </EuiPanel>
        );
      })}
    </section>
  );
};
