<b>Zendesk Apps Framework integration for TSANet Connect</b>

To use, contact membership@tsanet.org </br>
Use Issues https://github.com/tsanetgit/Zendesk_App/issues to log bugs and enhancements.

<b>Install Guide and Documentation:</b>

- [ZAF Quick Start](ZAF_Quick_Start.md)
- [ZIS Quick Start](ZIS_Quick_Start.md)
- [Full Implementation Guide (.docx)](Zendesk_PlainLanguage_Implementation_Guide_v2.15.docx)
- [GitHub Actions SLA Monitor (Optional)](GitHub_Actions_SLA_Monitor.md) — externally-hosted add-on, not required for the core integration
- [ZAF Custom Build Guide (Not Recommended)](ZAF_Custom_Build_Guide.md) — only for members who cannot, or will not, install the pre-built ZIP

<b>CURRENT PACKAGE VERSION:</b>
View the latest release https://github.com/tsanetgit/Zendesk_App/releases for the package link

<b>For maintainers — source of truth:</b>

This repository is the canonical source for the ZAF app. The deployed bundle under [`zaf-build/`](zaf-build/) is edited directly (no transpile/build step) and packaged with [`scripts/package.sh`](scripts/package.sh). Pushing a `v*` tag builds the installable zip and attaches it to a GitHub Release automatically. See [`zaf-build/README.md`](zaf-build/README.md) for the full edit-and-package loop. The old Vite source repo is archived and must not be used.
