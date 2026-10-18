# Documentation

**Open [`index.html`](index.html).** It leads to the two documents that describe Warraq ERP:

* [User manual](user-manual/warraq-erp-user-manual.html), for people who use the system.
* [Technical documentation](technical/index.html), for analysts, developers and testers.

Everything else in this folder is a source they are built from (`platform/`, `gl-ap-ar/`, `design-notes/`, `operations/`, `proposals/`, `test-cases/`, `user-manual/source/`), a related guide (`zatca/`, `reference/`) or history (`archive/`). Rebuild with `npx tsx scripts/build-gl-docs.mjs && node scripts/build-module-catalogue.mjs && node scripts/build-docs-html.mjs`; do not edit the generated HTML. The skill `.claude/skills/update-docs-after-development` is the procedure.
