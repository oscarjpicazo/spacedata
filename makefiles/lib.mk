# Function that prepends its argument ($(1)) to the PATH environment variable if it does not contain
# it yet. This is done by looking for `:$(1):` within `:$(PATH):`.
#
# Example use: $(call ADD_PATH , ./node_modules/.bin)
# To be used at the top-level of makefile.
ADD_PATH = $(eval PATH := $(if $(findstring :$(PATH_TO_ADD):,:$(PATH):),$(PATH),$(1):$(PATH)))

# Unlock more powerful features than plain POSIX sh.
SHELL := /bin/bash

$(call ADD_PATH , ./node_modules/.bin)

ifeq (,$(wildcard bun.lock))
$(call ADD_PATH , ../../node_modules/.bin)
endif

setup:
.PHONY: setup

build:
.PHONY: build

test:
.PHONY: test

clean:
.PHONY: clean
