# Set up pi skills package

This commit creates a version-controlled pi package for personal/global pi resources. The immediate goal is to stop treating global skills as loose files under pi's runtime directories and instead keep them in a normal git repository with history, reviewability, and rollback.

The package starts with two skills:

- `commit`, the custom commit workflow developed in this session.
- `web-search`, the existing global search skill and its helper scripts.

The existing `web-search` virtual environment is intentionally not copied into the repo. It is generated local state and can be recreated with the skill's setup script if Crawl4AI support is needed. The dependency-free fetch/search scripts are preserved.

The package manifest exposes `./skills` so pi can discover all skill directories conventionally. The README documents both normal global installation and package filtering, since future versions of this repo may contain more resources than should be enabled everywhere.

After this package is committed and installed globally, the old loose skill locations can be removed so there is a single source of truth for these skills.
