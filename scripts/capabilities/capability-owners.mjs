export const RepositoryUrl =
  'git+https://github.com/VelarOS-AI/VelarOS-Capabilities.git'

export const CapabilityOwners = [
  {
    owner: 'workspace',
    packages: [
      {
        directory: 'workspace',
        name: '@velaros-ai/workspace',
        version: '1.2.5',
        schemaExports: ['WorkspaceAgentToolSpecs'],
      },
    ],
  },
  {
    owner: 'browser',
    packages: [
      {
        directory: 'browser-core',
        name: '@velaros-ai/browser-core',
        version: '0.2.6',
        schemaExports: [],
      },
      {
        directory: 'browser-tools',
        name: '@velaros-ai/browser-tools',
        version: '0.2.5',
        schemaExports: [],
      },
      {
        directory: 'browser-composition',
        name: '@velaros-ai/browser-composition',
        version: '0.2.5',
        schemaExports: [],
      },
      {
        directory: 'browser-runtime',
        name: '@velaros-ai/browser-runtime',
        version: '0.2.5',
        schemaExports: [],
      },
    ],
  },
  {
    owner: 'computer',
    packages: [
      {
        directory: 'computer-runtime',
        name: '@velaros-ai/computer-runtime',
        version: '0.2.6',
        schemaExports: [],
      },
      {
        directory: 'computer-tools',
        name: '@velaros-ai/computer-tools',
        version: '0.2.6',
        schemaExports: ['computerTools'],
      },
    ],
  },
  {
    owner: 'system',
    packages: [
      {
        directory: 'system-tools',
        name: '@velaros-ai/system-tools',
        version: '0.2.8',
        schemaExports: ['systemTools', 'systemProjectTools'],
      },
    ],
  },
  {
    owner: 'office',
    packages: [
      {
        directory: 'office-tools',
        name: '@velaros-ai/office-tools',
        version: '0.2.7',
        schemaExports: ['officeTools'],
      },
    ],
  },
  {
    owner: 'composition',
    packages: [
      {
        directory: 'cli',
        name: '@velaros-ai/cli',
        version: '0.2.10',
        schemaExports: [],
      },
    ],
  },
]

export const CapabilityPackages = CapabilityOwners.flatMap(({ owner, packages }) =>
  packages.map((item) => ({ ...item, owner })),
)
