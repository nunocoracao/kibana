/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import React from 'react';
import { EuiPageTemplate } from '@elastic/eui';
import { NIGHTSHIFT_APP_ID } from '@kbn/deeplinks-observability';
import { i18n } from '@kbn/i18n';
import { NightshiftAppHeader } from '../../components/app_header';
import { useKibana } from '../../hooks/use_kibana';
import { AgentSourcesView } from './agent_sources_view';

export type SourcesPageHeaderProps = Record<string, never>;
export function SourcesPage({
  headerProps,
}: {
  headerProps: SourcesPageHeaderProps;
}): React.ReactElement {
  const { application } = useKibana().services;
  return (
    <>
      <NightshiftAppHeader
        {...headerProps}
        page="sources"
        back={{
          href: application.getUrlForApp(NIGHTSHIFT_APP_ID, { path: '/detections/agent' }),
          label: i18n.translate('xpack.nightshift.sourcesPage.backToAgent', {
            defaultMessage: 'Agent Explorer',
          }),
        }}
      />
      <EuiPageTemplate.Section component="div" restrictWidth={false}>
        <AgentSourcesView />
      </EuiPageTemplate.Section>
    </>
  );
}
