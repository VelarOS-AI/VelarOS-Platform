# VelarOS shared resources

VelarOS products share reusable, downloadable runtime artifacts through one user-level resource
store. CodeGraph is the first consumer; the contract is intentionally resource-neutral so future
products can reuse document converters, speech runtimes, grammar packs, and other bounded assets.

## Disk ABI v1

The canonical layout is:

```text
<VelarOS shared data>/
  shared/
    resources/
      <resource-id>/
        .velaros-resource.json
        <platform package or runtime files>
```

Platform defaults are:

- macOS: `~/Library/Application Support/VelarOS`
- Windows: `%LOCALAPPDATA%/VelarOS` (falling back to `%APPDATA%`)
- Linux: `$XDG_DATA_HOME/VelarOS` (falling back to `~/.local/share/VelarOS`)

`VELAROS_SHARED_DATA_ROOT` replaces the `<VelarOS shared data>` prefix for portable deployments
and tests. Products must consume `@velaros-ai/core/platform/shared-resources` instead of inventing a new
path policy.

## Ownership rules

- The shared store contains only reproducible installation artifacts and their integrity receipt.
- Product-specific configuration, enablement, project indexes, caches, and logs remain inside
  each product's own data root. Products using the shared account contract resolve its separate
  `shared/account/v1` directory through `accountRoot`; account sessions are not installation artifacts.
- A resource ID has one canonical installed copy for the current OS user. Products are consumers,
  not owners of private copies.
- Installed resources resolve from the canonical shared store. Do not probe product-local legacy
  roots or source-tree `node_modules`; development and tests must explicitly inject their resource location.
- Installation must verify the published artifact checksum before atomically replacing a resource
  directory. The receipt records schema version, resource ID, version, platform, architecture,
  artifact name, checksum, and installation time.

This boundary lets Desktop and Workbench independently enable or disable CodeGraph while executing
the same installed binary. Removing one product must not remove a resource still used by another
product. An individual product uninstaller must not collect shared resources without ownership and
reference evidence from their consumers.
