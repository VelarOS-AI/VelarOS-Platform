import { type ReactElement, useState } from 'react'
import { SettingsTabsFrame } from '@catalog/adapters/PreviewAdapters'
import { useI18n } from '@catalog/i18n'

import { Button } from '@velaros-ai/ui/primitives/buttons/Button'
import { Badge } from '@velaros-ai/ui/primitives/display/Badge'
import { Empty } from '@velaros-ai/ui/primitives/display/Empty'
import { Paragraph } from '@velaros-ai/ui/primitives/display/Paragraph'
import { Tag } from '@velaros-ai/ui/primitives/display/Tag'
import { Text } from '@velaros-ai/ui/primitives/display/Text'
import { Title } from '@velaros-ai/ui/primitives/display/Title'
import { Switch } from '@velaros-ai/ui/primitives/forms/Switch'
import { Card } from '@velaros-ai/ui/primitives/layout/Card'
import { Center } from '@velaros-ai/ui/primitives/layout/Center'
import { DescriptionItem, DescriptionList } from '@velaros-ai/ui/primitives/layout/DescriptionList'
import { Divider } from '@velaros-ai/ui/primitives/layout/Divider'
import { Flex } from '@velaros-ai/ui/primitives/layout/Flex'
import { Grid } from '@velaros-ai/ui/primitives/layout/Grid'
import { Inline } from '@velaros-ai/ui/primitives/layout/Inline'
import { List } from '@velaros-ai/ui/primitives/layout/List'
import { ListGroup,ListGroupItem } from '@velaros-ai/ui/primitives/layout/ListGroup'
import { Panel } from '@velaros-ai/ui/primitives/layout/Panel'
import { Col, Row } from '@velaros-ai/ui/primitives/layout/RowCol'
import { ScrollArea } from '@velaros-ai/ui/primitives/layout/ScrollArea'
import { Separator } from '@velaros-ai/ui/primitives/layout/Separator'
import { Space } from '@velaros-ai/ui/primitives/layout/Space'
import { Stack } from '@velaros-ai/ui/primitives/layout/Stack'
import { TabsContent } from '@velaros-ai/ui/primitives/layout/Tabs'
import { AppShell } from '@velaros-ai/ui/product/layout/AppShell'
import { CollapsibleNav } from '@velaros-ai/ui/product/layout/CollapsibleNav'

import foundationLayoutExampleStyles from '@catalog/styles/FoundationLayoutExamples.module.css'

const F = 'componentLibrary.foundationLayoutExample' as const

function SettingsShellTabsPreview(): ReactElement {
  const [tab, setTab] = useState('system')
  const { t } = useI18n()

  return (
    <div data-library-settings-tabs-preview>
      <SettingsTabsFrame
        title={t('settings.title')}
        tabs={[
          { value: 'system', label: t('settings.tabSystem') },
          { value: 'model', label: t('settings.tabModel') },
        ]}
        value={tab}
        onValueChange={setTab}
      >
        <TabsContent value="system">
          <Panel variant="inset">{t('componentLibrary.exampleLayoutSystemSections')}</Panel>
        </TabsContent>
        <TabsContent value="model">
          <Panel variant="inset">{t('componentLibrary.exampleLayoutModelTab')}</Panel>
        </TabsContent>
      </SettingsTabsFrame>
    </div>
  )
}

export function LayoutPrimitiveExamples(): ReactElement {
  const [shellCollapsed, setShellCollapsed] = useState(false)
  const [closableTagOn, setClosableTagOn] = useState(true)
  const { t } = useI18n()

  return (
    <Stack gap="sm">
      <Card
        title={t(`${F}.toolkitTitle`)}
        size="sm"
        extra={
          <Badge variant="secondary">{t(`${F}.lightAntdStyleBadge`)}</Badge>
        }
      >
        <Stack gap="md">
          <Grid columns={2} gap="md">
            <Stack gap="xs">
              <Text tone="strong">Flex</Text>
              <Flex justify="between" align="center" gap="sm">
                <Text tone="caption">{t(`${F}.flexCaptionHorizontal`)}</Text>
                <Button size="sm" variant="outline">
                  {t(`${F}.action`)}
                </Button>
              </Flex>
            </Stack>
            <Stack gap="xs">
              <Text tone="strong">Space</Text>
              <Space split="|" size="sm">
                <Badge variant="outline">A</Badge>
                <Badge variant="outline">B</Badge>
                <Badge variant="outline">C</Badge>
              </Space>
            </Stack>
          </Grid>
          <Row gutter="sm" align="middle">
            <Col span={8}>
              <Panel variant="inset">
                <Text tone="caption">8 / 24</Text>
              </Panel>
            </Col>
            <Col span={16}>
              <Panel variant="inset">
                <Text tone="caption">16 / 24</Text>
              </Panel>
            </Col>
          </Row>
          <ListGroup
            header={t(`${F}.listGroupHeader`)}
            footer={
              <Text tone="caption">{t(`${F}.listGroupFooterCaption`)}</Text>
            }
          >
            <ListGroupItem interactive>{t(`${F}.interactiveRow`)}</ListGroupItem>
            <ListGroupItem>{t(`${F}.staticRow`)}</ListGroupItem>
          </ListGroup>
          <Divider type="dashed">{t(`${F}.dividerTypography`)}</Divider>
          <Stack gap="xs">
            <Title level={5}>{t(`${F}.titleLevel5`)}</Title>
            <Paragraph tone="secondary" spacing="sm">
              {t(`${F}.paragraphPrefer`)}
            </Paragraph>
          </Stack>
          <DescriptionList bordered columns={2}>
            <DescriptionItem label={t(`${F}.labelName`)}>VelarOS</DescriptionItem>
            <DescriptionItem label={t(`${F}.labelVersion`)}>0.1.0</DescriptionItem>
            <DescriptionItem label={t(`${F}.labelDetail`)} spanFull>
              {t(`${F}.spanFullCaption`)}
            </DescriptionItem>
          </DescriptionList>
          <Inline gap="sm" wrap="wrap" align="center">
            <Tag variant="info">info</Tag>
            <Tag variant="success">success</Tag>
            {closableTagOn ? (
              <Tag
                variant="outline"
                closable
                onClose={() => setClosableTagOn(false)}
                closeLabel={t(`${F}.closeLabelRemove`)}
              >
                closable
              </Tag>
            ) : (
              <Text tone="caption">{t(`${F}.closableTagRemoved`)}</Text>
            )}
          </Inline>
          <Panel variant="inset" className="min-h-0 overflow-hidden p-0">
            <Center className="min-h-[100px]">
              <Empty
                imageSize="sm"
                image={<span aria-hidden>📭</span>}
                title={<Title level={5}>{t(`${F}.emptyNoData`)}</Title>}
                description={
                  <Text tone="caption">{t(`${F}.emptyDescription`)}</Text>
                }
                extra={
                  <Button size="sm" variant="outline">
                    {t(`${F}.action`)}
                  </Button>
                }
              />
            </Center>
          </Panel>
        </Stack>
      </Card>
      <Inline gap="sm" wrap="wrap">
        <Badge variant="secondary">{t(`${F}.inlineGroupBadge`)}</Badge>
        <Button size="sm" variant="outline">
          {t(`${F}.action`)}
        </Button>
      </Inline>
      <Separator />
      <ScrollArea axis="y" style={{ maxHeight: 88 }}>
        <List
          items={['Workspace', 'Chat', 'Debug', 'Settings']}
          keyExtractor={(item) => item}
          renderItem={(item) => (
            <Panel key={item} variant="inset">
              {item}
            </Panel>
          )}
        />
      </ScrollArea>
      <CollapsibleNav
        itemLabel={t(`${F}.navItemLabel`)}
        selectedItemId="buttons"
        groups={[
          {
            id: 'foundation',
            title: t(`${F}.navGroupFoundationTitle`),
            count: 2,
            items: [
              {
                id: 'buttons',
                label: 'Button / IconButton',
                description: t(`${F}.navButtonsDescription`),
              },
              { id: 'fields', label: 'Input', description: t(`${F}.navFieldsDescription`) },
            ],
          },
        ]}
      />
      <Separator />
      <Stack gap="xs">
        <Inline gap="sm" align="center" wrap="wrap">
          <Text tone="strong">AppShell</Text>
          <Switch
            size="sm"
            tone="neutral"
            checked={shellCollapsed}
            onCheckedChange={setShellCollapsed}
            aria-label={t(`${F}.ariaSidebarCollapsed`)}
          />
          <Text tone="caption">{t(`${F}.appShellHint`)}</Text>
        </Inline>
        <div
          className={foundationLayoutExampleStyles.shellPreview}
          style={{ height: 220 }}
        >
          <AppShell
            embedded
            sidebarCollapsed={shellCollapsed}
            sidebar={
              <aside
                className={foundationLayoutExampleStyles.appShellSidebar}
                style={{
                  width: shellCollapsed
                    ? 'var(--shell-sidebar-collapsed-width)'
                    : 'var(--shell-sidebar-expanded-width)',
                }}
              >
                {t(`${F}.sidebarPlaceholder`)}
              </aside>
            }
            header={
              <div className={foundationLayoutExampleStyles.appShellHeader}>
                {t(`${F}.topBarPlaceholder`)}
              </div>
            }
          >
            <Panel variant="inset" className="m-2 text-[11px] text-muted-foreground">
              {t(`${F}.mainContentPlaceholder`)}
            </Panel>
          </AppShell>
        </div>
      </Stack>
    </Stack>
  )
}

export const layoutRecommendations = [
  {
    id: 'project-discovery-roots-list',
    title: '可编辑扫描根列表',
    description:
      'ProjectDiscoveryRootsPanel 在设置卡片内堆叠密集行与行内操作；用 Stack、Inline、Button 与边框 token 拼出，而非单独再抽一层目录级 primitive。',
    code: `// components/business/system/ProjectDiscoveryRootsPanel.tsx
<Stack gap="sm">...</Stack>`,
  },
]

export const tabsRecommendations = [
  {
    id: 'local-tabs',
    title: '设置页外壳',
    description:
      '与 SettingsPage 相同：ScrollArea + Stack + Tabs，含标题行与 TabsList；每个面板是 TabsContent。优先复用 SettingsTabsFrame，避免壳层重复实现。',
    preview: <SettingsShellTabsPreview />,
    code: `// pages/SettingsPage.tsx — 外壳来自 components/settings/layout/SettingsTabsFrame.tsx
import { SettingsTabsFrame } from '@catalog/adapters/PreviewAdapters'

<SettingsTabsFrame title={t('settings.title')} tabs={tabs} value={activeTab} onValueChange={setActiveTab}>
  <TabsContent value="system">
    <SystemSettingsSection />
  </TabsContent>
</SettingsTabsFrame>`,
  },
]
