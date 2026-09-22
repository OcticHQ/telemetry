# A facade, nothing more. Every target below shells out to the component's own
# toolchain — the canonical commands live in node/package.json and
# contract/package.json, and this file exists so nobody has to remember which
# language uses which runner.
#
# Deliberately not a build system. There is no dependency graph here, no
# caching, and no root package manager. When a second language arrives it adds
# targets here and changes nothing else.

.DEFAULT_GOAL := help
.PHONY: help check install \
        contract-generate contract-generate-local contract-check \
        node-install node-lint node-format node-typecheck node-test node-build node-pack \
        python-install python-lint python-format python-typecheck python-test python-build \
        repo-check

help: ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

# ── everything ───────────────────────────────────────────────────────────────

install: node-install python-install ## Install every component's dependencies
	npm --prefix contract ci

check: contract-check repo-check node-lint node-typecheck node-test python-lint python-typecheck python-test ## Run what CI runs

# ── contract ─────────────────────────────────────────────────────────────────

contract-generate: ## Regenerate the per-language constants, ATTRIBUTES.md and the contracts artifact
	npm --prefix contract run generate

# What the pre-commit hook runs. Skips the targets that write into a sibling
# repository — see the hook comment in .pre-commit-config.yaml.
contract-generate-local: ## Regenerate this repo's artifacts only
	npm --prefix contract run generate:local

contract-check: ## Fail if the generated artifacts are stale or a list drifted
	npm --prefix contract run check

# ── node ─────────────────────────────────────────────────────────────────────

node-install: ## Install the Node SDK's dependencies
	npm --prefix node ci

node-lint: ## eslint + prettier --check
	npm --prefix node run lint
	npm --prefix node run format:check

node-format: ## prettier --write
	npm --prefix node run format

node-typecheck: ## tsc --noEmit over src and test
	npm --prefix node run typecheck

node-test: ## node --test
	npm --prefix node test

node-build: ## tsc to dist/
	npm --prefix node run build

node-pack: ## Build, then lint the tarball a consumer would receive
	npm --prefix node run pack:check

# ── python ───────────────────────────────────────────────────────────────────

# Override to point at a virtualenv: `make python-test PY=python/.venv/bin/python`.
# Everything below is what .github/workflows/_python.yml runs, from the same
# directory, so a green `make` and a green CI mean the same thing.
#
# The recipes `cd python` first, which would otherwise resolve a relative
# override against the wrong directory — silently, if a `python` happens to
# exist at the matching path under python/. Anything with a slash in it is
# absolutized here; a bare command is left alone for PATH to find.
PY ?= python3
PY_CMD := $(if $(findstring /,$(PY)),$(abspath $(PY)),$(PY))

python-install: ## Install the Python SDK's dependencies (`--group` needs pip 25.1+)
	$(PY_CMD) -m pip install --upgrade 'pip>=25.1'
	cd python && $(PY_CMD) -m pip install -e . --group dev

python-lint: ## ruff check + ruff format --check
	cd python && $(PY_CMD) -m ruff check src tests
	cd python && $(PY_CMD) -m ruff format --check src tests

python-format: ## ruff format
	cd python && $(PY_CMD) -m ruff format src tests

python-typecheck: ## mypy over src and tests
	cd python && $(PY_CMD) -m mypy src tests

python-test: ## pytest
	cd python && $(PY_CMD) -m pytest

python-build: ## Build the wheel and sdist, then lint what a consumer would install
	cd python && $(PY_CMD) -m build
	cd python && $(PY_CMD) -m twine check --strict dist/*

# ── repo ─────────────────────────────────────────────────────────────────────

# The merge-base fallback is for a clone with no `origin/main` yet — checking
# every commit is the safe direction, and an empty base would make
# check-commits.sh exit non-zero rather than pass silently.
repo-check: ## Component registration + conventional commits since origin/main
	./scripts/check-component-registration.sh
	./scripts/check-commits.sh "$$(git merge-base origin/main HEAD 2>/dev/null || git rev-list --max-parents=0 HEAD)"
