include ../../makefiles/lib.mk
include ../../makefiles/formatting.mk
include ../../makefiles/simple-ts.mk

build: setup typecheck
	bun build ./src/cli.ts --outdir dist --target node;
.PHONY: build
