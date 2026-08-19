import { afterEach, describe, expect, test } from 'bun:test'

import { normalizeArguments, packagedResourcesRoot } from '../src/bin'

const originalResourcesRoot = process.env.VELAROS_HOST_RESOURCES_ROOT

afterEach(() => {
  if (originalResourcesRoot === undefined)
    delete process.env.VELAROS_HOST_RESOURCES_ROOT
  else process.env.VELAROS_HOST_RESOURCES_ROOT = originalResourcesRoot
})

describe('Velar Host product entry', () => {
  test('starts in the safe default workspace when no project is provided', () => {
    expect(normalizeArguments([], '/Users/example/VelarOS')).toEqual([
      '--project-root',
      '/Users/example/VelarOS',
    ])
    expect(normalizeArguments(['start'], '/Users/example/VelarOS')).toEqual([
      'start',
      '--project-root',
      '/Users/example/VelarOS',
    ])
  })

  test('preserves explicit projects and management commands', () => {
    expect(
      normalizeArguments(
        ['serve', 'start', '--project-root', '/tmp/project'],
        '/Users/example/VelarOS',
      ),
    ).toEqual(['start', '--project-root', '/tmp/project'])
    expect(
      normalizeArguments(['status', '--json'], '/Users/example/VelarOS'),
    ).toEqual(['status', '--json'])
  })

  test('uses an explicit packaged resource root', () => {
    process.env.VELAROS_HOST_RESOURCES_ROOT = '/opt/velar-host/resources'
    expect(packagedResourcesRoot()).toBe('/opt/velar-host/resources')
  })
})
