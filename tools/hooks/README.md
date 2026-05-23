# Git hooks

Project-local git hooks for `zotero-watch-folder`.

## `commit-msg` — strip AI co-author trailers

GitHub indexes `Co-Authored-By:` trailers as repository contributors. If your
editor or assistant (Claude Code, Copilot, Cursor, Codeium, Cody, Aider, …)
auto-attaches itself as a co-author, those bots show up on the project's
contributors page and can only be removed by rewriting history and
force-pushing `main`.

This hook scrubs those trailers at commit time so they never enter history.

### Install (one command)

```sh
git config core.hooksPath tools/hooks
```

That tells your local git to look in `tools/hooks/` for hooks instead of the
default `.git/hooks/`. The hook then runs on every commit you make in this
clone.

### Verify

```sh
printf 'test: dummy\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n' \
  | tee /tmp/m
tools/hooks/commit-msg /tmp/m
cat /tmp/m   # the trailer should be gone
```

### Scope

The hook is **conservative**: it only strips trailers whose value clearly
identifies a known AI bot (Claude, Copilot, GitHub Copilot, Cursor, Codeium,
Cody, Aider) or carries one of their `noreply` addresses. Trailers from human
co-authors are left alone.

### Why not a global rule?

`core.hooksPath` is per-clone, not global. If you also work on this repo from
another machine or clone, re-run the install command there.
