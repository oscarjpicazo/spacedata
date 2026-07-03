include makefiles/lib.mk

ALL_PACKAGES := cli

comma := ,

define forall_make
	$(eval PKGS := $(subst $(comma), ,$(strip $(1))))
	$(eval TARGET := $(2))
	for name in $(addprefix packages/,$(PKGS)); do\
		echo "Running make $(TARGET) in $${name}";\
		make $(TARGET) --directory=$${name} || exit 1;\
	done
endef

setup:
	$(call forall_make, $(ALL_PACKAGES), setup)
.PHONY: setup

format:
	$(call forall_make, $(ALL_PACKAGES), format)
.PHONY: format

check:
	$(call forall_make, $(ALL_PACKAGES), check)
.PHONY: check

check.fix:
	$(call forall_make, $(ALL_PACKAGES), fix)
.PHONY: check.fix

build:
	$(call forall_make, $(ALL_PACKAGES), build)
.PHONY: build

test:
	$(call forall_make, $(ALL_PACKAGES), test)
.PHONY: test

clean:
	$(call forall_make, $(ALL_PACKAGES), clean)
.PHONY: clean

clean-deps-root:
	rm -rf node_modules
.PHONY: clean-deps-root

clean-deps: clean-deps-root
	$(call forall_make, $(ALL_PACKAGES), clean-deps)
.PHONY: clean-deps

nuke: clean-deps-root
	$(call forall_make, $(ALL_PACKAGES), nuke)
.PHONY: nuke
