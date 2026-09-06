# Governance

VelarOS Platform uses a maintainer-led, evidence-driven governance model.

## Roles

**Contributors** propose changes, report issues, improve documentation, and review work.

**Maintainers** have repository write access and are responsible for review quality, security response, release integrity, and keeping architectural ownership explicit.

**Release maintainers** are maintainers authorized to publish packages and manage release credentials. Publishing authority is narrower than ordinary merge authority.

## Decision making

Routine changes are decided through pull-request review. Maintainers seek consensus and use the repository's documented contracts, tests, and architecture gates as evidence.

Changes to public protocols, permission or trust models, persisted data, package ownership, compatibility policy, licensing, or release security require a written design record before implementation. The decision and its rationale must live in this repository so external contributors can inspect the same authority as maintainers.

If consensus is not possible, maintainers document the competing options, risks, and final decision. Security embargoes may temporarily limit public detail, but the durable contract must be documented after disclosure.

## Maintainer changes

New maintainers are added based on sustained, high-quality contributions and sound judgment across code, review, security, and community conduct. Maintainers who are inactive or unable to meet the role's responsibilities may step down or be removed by the remaining maintainers.

Current maintainers:

- [Error-Zhang](https://github.com/Error-Zhang) — maintainer and release maintainer.

Repository access controls remain the authority for current write and release permissions. This roster documents that authority for contributors and must be updated whenever maintainer access changes.

## Releases

Release artifacts are produced only from reviewed commits through the repository's release workflow. Package versions follow semantic versioning, while `velaros.platform` identifies cross-package compatibility generations.
