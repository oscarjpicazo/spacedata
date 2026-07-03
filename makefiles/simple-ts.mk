SHELL := /bin/bash
TSC_BIN ?= bunx tsc

setup: node_modules
.PHONY: setup

typecheck:
	$(TSC_BIN) --noEmit;
.PHONY: typecheck

clean:
	rm -rf dist
.PHONY: clean

clean-deps:
	rm -rf node_modules
.PHONY: clean-deps

test:
	bun test;
.PHONY: test

nuke: clean clean-deps
.PHONY: nuke

node_modules: package.json
	bun install
